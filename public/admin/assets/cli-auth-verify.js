(() => {
  try {
    const stored = localStorage.getItem('adminTheme');
    if (stored && ['auto', 'light', 'dark', 'bright-pink', 'dark-pink'].includes(stored)) {
      document.body.dataset.theme = stored;
    }
  } catch (_) {}

  const codeForm = document.getElementById('cliAuthCodeForm');
  const codeInput = document.getElementById('cliAuthCode');
  const codeError = document.getElementById('cliAuthError');
  const lookupBtn = document.getElementById('cliAuthLookup');

  const confirmSection = document.getElementById('cliAuthConfirm');
  const fqdnEl = document.getElementById('cliAuthFqdn');
  const ipEl = document.getElementById('cliAuthIp');
  const approveBtn = document.getElementById('cliAuthApproveBtn');
  const denyBtn = document.getElementById('cliAuthDenyBtn');
  const approveError = document.getElementById('cliAuthApproveError');

  const resultSection = document.getElementById('cliAuthResult');
  const resultMsg = document.getElementById('cliAuthResultMsg');

  if (!codeForm || !codeInput || !confirmSection || !approveBtn || !denyBtn) {
    return;
  }

  let pendingUserCode = '';

  function showError(el, msg) {
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
  }

  function clearError(el) {
    if (!el) return;
    el.textContent = '';
    el.hidden = true;
  }

  function setLoading(btn, loading) {
    if (!btn) return;
    btn.disabled = loading;
    const label = btn.querySelector('.btn-label');
    if (label) {
      label.dataset.origText = label.dataset.origText || label.textContent;
      label.textContent = loading ? 'Please wait\u2026' : label.dataset.origText;
    }
  }

  // Auto-format: uppercase and insert hyphen after 4 chars
  codeInput.addEventListener('input', () => {
    let val = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (val.length > 4) {
      val = val.slice(0, 4) + '-' + val.slice(4, 8);
    }
    codeInput.value = val;
  });

  // Step 1: Look up code
  codeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError(codeError);

    const code = codeInput.value.trim().toUpperCase();
    if (code.length < 9) {
      showError(codeError, 'Enter the full 9-character code (e.g. ABCD-1234).');
      return;
    }

    setLoading(lookupBtn, true);

    try {
      const res = await fetch('/cli/auth/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ user_code: code }),
      });

      const data = await res.json();

      if (!res.ok || data.status !== 'ok') {
        showError(codeError, data.message || 'Login request not found or expired.');
        setLoading(lookupBtn, false);
        return;
      }

      pendingUserCode = code;
      fqdnEl.textContent = data.data.fqdn || 'unknown';
      ipEl.textContent = data.data.ip || 'unknown';

      codeForm.hidden = true;
      confirmSection.hidden = false;
    } catch (err) {
      showError(codeError, 'Network error. Please try again.');
      setLoading(lookupBtn, false);
    }
  });

  // Step 2a: Approve
  approveBtn.addEventListener('click', async () => {
    clearError(approveError);
    setLoading(approveBtn, true);
    setLoading(denyBtn, true);

    try {
      const res = await fetch('/cli/auth/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ user_code: pendingUserCode }),
      });

      const data = await res.json();

      if (!res.ok || data.status !== 'ok') {
        showError(approveError, data.message || 'Failed to approve request.');
        setLoading(approveBtn, false);
        setLoading(denyBtn, false);
        return;
      }

      confirmSection.hidden = true;
      resultSection.hidden = false;
      resultMsg.textContent = 'Host ' + (data.data.fqdn || 'unknown') + ' has been authorized. The CLI will pick up the credentials shortly.';
    } catch (err) {
      showError(approveError, 'Network error. Please try again.');
      setLoading(approveBtn, false);
      setLoading(denyBtn, false);
    }
  });

  // Step 2b: Deny
  denyBtn.addEventListener('click', async () => {
    clearError(approveError);
    setLoading(approveBtn, true);
    setLoading(denyBtn, true);

    try {
      const res = await fetch('/cli/auth/deny', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ user_code: pendingUserCode }),
      });

      const data = await res.json();

      if (!res.ok || data.status !== 'ok') {
        showError(approveError, data.message || 'Failed to deny request.');
        setLoading(approveBtn, false);
        setLoading(denyBtn, false);
        return;
      }

      confirmSection.hidden = true;
      resultSection.hidden = false;
      resultMsg.textContent = 'Login request has been denied.';
    } catch (err) {
      showError(approveError, 'Network error. Please try again.');
      setLoading(approveBtn, false);
      setLoading(denyBtn, false);
    }
  });
})();
