// Package remote reserves the `cxx remote` command grammar and signed policy
// gate. It validates arguments and emits structured errors, but every operational
// verb returns E_NOT_IMPLEMENTED. SSH transport, remote jobs and file transfer
// are not implemented. The configuration switch does not restrict ordinary SSH.
package remote
