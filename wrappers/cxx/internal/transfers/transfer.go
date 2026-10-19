package transfers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

type upload struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Size   int64  `json:"size_bytes"`
	SHA256 string `json:"content_sha256"`
	TTL    int64  `json:"ttl_seconds"`
}
type journal struct {
	Version int    `json:"version"`
	Server  string `json:"server"`
	Engine  string `json:"engine"`
	Path    string `json:"path"`
	Upload  upload `json:"upload"`
}

func hashFile(ctx context.Context, f *os.File) (string, error) {
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	h := sha256.New()
	if _, err := io.Copy(h, &contextReader{Reader: f, ctx: ctx}); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func readJournal(path string) (journal, error) {
	f, err := os.Open(path)
	if err != nil {
		return journal{}, err
	}
	defer f.Close()
	var j journal
	err = json.NewDecoder(io.LimitReader(f, 64<<10)).Decode(&j)
	if err == nil && j.Version != 1 {
		err = fmt.Errorf("unsupported transfer journal")
	}
	return j, err
}
func writeJournal(path string, j journal) error {
	raw, err := json.Marshal(j)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return fmt.Errorf("resume journal already exists or cannot be created: %w", err)
	}
	if _, err = f.Write(raw); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	return closeErr
}
func (c *Client) progress(done, total int64) {
	if c.Progress != nil {
		fmt.Fprintf(c.Progress, "transfer: %d / %d bytes\n", done, total)
	}
}

// PutError reports an upload failure after its journal exists. The server may
// already hold the transfer (a lost response, such as a disconnected local
// communicator, leaves the outcome unknown), so the caller names the ID, the
// journal and both ways out: --resume repeats the idempotent creation and
// continues at the confirmed offset; abandoning needs the server copy deleted.
type PutError struct {
	ID, Journal, Path, Engine string
	Err                       error
}

func (e *PutError) Error() string { return e.Err.Error() }
func (e *PutError) Unwrap() error { return e.Err }

// ResumeCommand is the exact command that continues this upload.
func (e *PutError) ResumeCommand() string {
	return "cxx transfer put " + shellQuote(e.Path) + " --resume --engine " + e.Engine
}

// Guidance is the human recovery text printed after the error.
func (e *PutError) Guidance() string {
	return fmt.Sprintf("transfer %s may already exist on the server; its outcome is not confirmed.\n"+
		"  resume:  %s\n"+
		"  abandon: delete transfer %s (MCP transfer_delete), then remove %s\n"+
		"An abandoned upload otherwise expires with its TTL; a new plain put of this file is refused while the journal exists.",
		e.ID, e.ResumeCommand(), e.ID, shellQuote(e.Journal))
}

func shellQuote(s string) string {
	if s != "" && strings.Trim(s, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/._-+=:@,") == "" {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func (c *Client) Put(ctx context.Context, path string, ttl int64, resume bool) (Transfer, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return Transfer{}, err
	}
	f, err := os.Open(absolute)
	if err != nil {
		return Transfer{}, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return Transfer{}, err
	}
	if !info.Mode().IsRegular() {
		return Transfer{}, fmt.Errorf("source must be a regular file")
	}
	if info.Size() > 9007199254740991 {
		return Transfer{}, fmt.Errorf("file size exceeds the server's exact integer range")
	}
	if c.Progress != nil {
		fmt.Fprintln(c.Progress, "transfer: calculating SHA-256")
	}
	hash, err := hashFile(ctx, f)
	if err != nil {
		return Transfer{}, err
	}
	j := journal{Version: 1, Server: c.BaseURL, Engine: c.Engine, Path: absolute, Upload: upload{ID: uuid.NewString(), Name: filepath.Base(path), Size: info.Size(), SHA256: hash, TTL: ttl}}
	statePath := absolute + ".cxx-upload.json"
	if resume {
		old, e := readJournal(statePath)
		if e != nil {
			return Transfer{}, e
		}
		if old.Server != j.Server || old.Engine != j.Engine || old.Path != j.Path || old.Upload.Size != j.Upload.Size || old.Upload.SHA256 != hash {
			return Transfer{}, fmt.Errorf("source file or transfer destination changed; start a new upload")
		}
		j = old
	} else if err = writeJournal(statePath, j); err != nil {
		return Transfer{}, err
	}
	result, err := c.upload(ctx, f, j, hash)
	if err != nil {
		return Transfer{}, &PutError{ID: j.Upload.ID, Journal: statePath, Path: absolute, Engine: c.Engine, Err: err}
	}
	if err = os.Remove(statePath); err != nil {
		return Transfer{}, err
	}
	return result, nil
}

func (c *Client) upload(ctx context.Context, f *os.File, j journal, hash string) (Transfer, error) {
	// Repeating creation is safe after a lost response; the UUID and full source
	// fingerprint are persisted BEFORE the first request.
	result, err := c.metadata(ctx, "POST", "", j.Upload)
	if err != nil {
		return Transfer{}, err
	}
	if result.ChunkBytes <= 0 || result.ChunkBytes > chunkBytes {
		return Transfer{}, fmt.Errorf("invalid server chunk size")
	}
	for result.Transfer.Status == "uploading" && result.Transfer.Size < j.Upload.Size {
		offset := result.Transfer.Size
		if offset < 0 || offset > j.Upload.Size {
			return Transfer{}, fmt.Errorf("invalid server offset")
		}
		n := min(result.ChunkBytes, j.Upload.Size-offset)
		resp, stop, e := c.request(ctx, "PUT", "/"+j.Upload.ID+"/content?offset="+strconv.FormatInt(offset, 10), io.NewSectionReader(f, offset, n), n, true)
		if e != nil {
			return Transfer{}, e
		}
		next, e := decode(resp.Body)
		resp.Body.Close()
		stop()
		if e != nil {
			return Transfer{}, e
		}
		if next.Transfer.ID != j.Upload.ID || next.Transfer.Size != offset+n {
			return Transfer{}, fmt.Errorf("server did not confirm the uploaded bytes")
		}
		result.Transfer = next.Transfer
		c.progress(next.Transfer.Size, j.Upload.Size)
	}
	if result.Transfer.Status != "live" {
		result, err = c.metadata(ctx, "POST", "/"+j.Upload.ID+"/complete", nil)
		if err != nil {
			return Transfer{}, err
		}
	}
	if result.Transfer.ID != j.Upload.ID || result.Transfer.Size != j.Upload.Size || result.Transfer.SHA256 != hash || result.Transfer.Status != "live" {
		return Transfer{}, fmt.Errorf("server returned an unverified transfer")
	}
	return result.Transfer, nil
}

func (c *Client) Get(ctx context.Context, id, path string, resume, overwrite bool) (Transfer, error) {
	if _, err := uuid.Parse(id); err != nil {
		return Transfer{}, fmt.Errorf("invalid transfer ID")
	}
	result, err := c.metadata(ctx, "GET", "/"+id, nil)
	if err != nil {
		return Transfer{}, err
	}
	t := result.Transfer
	if t.ID != id || t.Status != "live" || t.Size < 0 || len(t.SHA256) != 64 {
		return Transfer{}, fmt.Errorf("transfer is incomplete or invalid")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return Transfer{}, err
	}
	if !overwrite {
		if _, e := os.Lstat(absolute); e == nil {
			return Transfer{}, fmt.Errorf("target exists; use --overwrite")
		} else if !errors.Is(e, os.ErrNotExist) {
			return Transfer{}, e
		}
	}
	partial := absolute + ".cxx-part"
	statePath := partial + ".json"
	j := journal{Version: 1, Server: c.BaseURL, Engine: c.Engine, Path: absolute, Upload: upload{ID: id, Size: t.Size, SHA256: t.SHA256}}
	flags := os.O_RDWR | os.O_CREATE | os.O_EXCL
	if resume {
		old, e := readJournal(statePath)
		if e != nil {
			return Transfer{}, e
		}
		if old != j {
			return Transfer{}, fmt.Errorf("download journal belongs to a different file or server")
		}
		flags = os.O_RDWR
	} else if err = writeJournal(statePath, j); err != nil {
		return Transfer{}, err
	}
	f, err := os.OpenFile(partial, flags, 0600)
	if err != nil {
		return Transfer{}, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return Transfer{}, err
	}
	offset := info.Size()
	if !info.Mode().IsRegular() || offset > t.Size {
		return Transfer{}, fmt.Errorf("invalid partial download")
	}
	if _, err = f.Seek(offset, io.SeekStart); err != nil {
		return Transfer{}, err
	}
	// Fetch empty files too, so a real empty file receives the same auth/audit path.
	if offset < t.Size || (!resume && t.Size == 0) {
		reqCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		// Build through request() to retain configured CA, redirect policy and idle
		// cancellation, while adding Range before the request is sent.
		h := *c.HTTP
		h.Transport = rangeTransport{base: c.HTTP.Transport, offset: offset}
		downloadClient := *c
		downloadClient.HTTP = &h
		resp, stop, e := downloadClient.request(reqCtx, "GET", "/"+id+"/content", nil, 0, false)
		if e != nil {
			return Transfer{}, e
		}
		defer stop()
		defer resp.Body.Close()
		if resp.Header.Get("ETag") != "\""+t.SHA256+"\"" {
			return Transfer{}, fmt.Errorf("download hash identity changed")
		}
		if offset > 0 && (resp.StatusCode != http.StatusPartialContent || resp.Header.Get("Content-Range") != fmt.Sprintf("bytes %d-%d/%d", offset, t.Size-1, t.Size)) {
			return Transfer{}, fmt.Errorf("server did not honor the resume range")
		}
		if resp.ContentLength != t.Size-offset {
			return Transfer{}, fmt.Errorf("download length differs from metadata")
		}
		written, e := io.Copy(&downloadWriter{file: f, client: c, done: offset, total: t.Size, last: offset, at: time.Now()}, io.LimitReader(resp.Body, t.Size-offset+1))
		if syncErr := f.Sync(); e == nil {
			e = syncErr
		}
		if e != nil {
			return Transfer{}, fmt.Errorf("download interrupted; use --resume: %w", e)
		}
		if offset+written != t.Size {
			return Transfer{}, fmt.Errorf("incomplete download; use --resume")
		}
		c.progress(offset+written, t.Size)
	}
	hash, err := hashFile(ctx, f)
	if err != nil {
		return Transfer{}, err
	}
	if hash != t.SHA256 {
		return Transfer{}, fmt.Errorf("SHA-256 mismatch; discard the partial download and retry")
	}
	if err = f.Sync(); err != nil {
		return Transfer{}, err
	}
	if err = f.Close(); err != nil {
		return Transfer{}, err
	}
	if overwrite {
		err = os.Rename(partial, absolute)
	} else {
		// Link is an atomic no-clobber publication on the same filesystem.
		err = os.Link(partial, absolute)
		if err == nil {
			err = os.Remove(partial)
		}
	}
	if err != nil {
		return Transfer{}, err
	}
	if err = os.Remove(statePath); err != nil {
		return Transfer{}, err
	}
	return t, nil
}

type rangeTransport struct {
	base   http.RoundTripper
	offset int64
}

func (t rangeTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	if t.offset > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", t.offset))
	}
	base := t.base
	if base == nil {
		base = http.DefaultTransport
	}
	return base.RoundTrip(req)
}

type contextReader struct {
	io.Reader
	ctx context.Context
}

func (r *contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.Reader.Read(p)
}

type downloadWriter struct {
	file              *os.File
	client            *Client
	done, total, last int64
	at                time.Time
}

func (w *downloadWriter) Write(p []byte) (int, error) {
	n, err := w.file.Write(p)
	w.done += int64(n)
	if w.client.Progress != nil && (w.done-w.last >= 16<<20 || time.Since(w.at) >= time.Second) {
		w.client.progress(w.done, w.total)
		w.last = w.done
		w.at = time.Now()
	}
	return n, err
}
