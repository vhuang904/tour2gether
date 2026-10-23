// A small, dismissible prompt exclusively for server-confirmed missing Google email.
let installed = false;
export function installMemberEmailPrompt(confirmEmail) {
  if (installed) return;
  installed = true;
  const dismissed = new Set();
  let member = null, panel = null, busy = false, errorCode = '', completed = false;
  const copy = {
    'zh-TW': {
      title: '確認週報收件信箱',
      body: '你的帳號尚未保存信箱。請確認同一個 Google 帳號，自動補上信箱。',
      confirm: '確認 Google 帳號', later: '稍後再說', working: '正在確認…',
      saved: '信箱已儲存', done: '完成',
      failed: '尚未完成信箱同步，請再試一次。',
      mismatch: '請選擇目前登入的同一個 Google 帳號。',
      cancelled: '已取消，信箱尚未同步。',
      missing: '尚未取得或保存信箱，請再試一次。'
    },
    en: {
      title: 'Confirm your newsletter email',
      body: 'Your account has no saved email. Confirm the same Google account to add it automatically.',
      confirm: 'Confirm Google account', later: 'Not now', working: 'Confirming…',
      saved: 'Email saved', done: 'Done',
      failed: 'Email sync did not finish. Please try again.',
      mismatch: 'Please select the same Google account you are signed in with.',
      cancelled: 'Cancelled. Your email has not been synced.',
      missing: 'We could not retrieve or save your email. Please try again.'
    }
  };
  function remove() { panel?.remove(); panel = null; }
  function render() {
    if (!member || dismissed.has(member.uid) || (!member.required && !busy && !completed)) { remove(); return; }
    const t = copy[document.documentElement.lang === 'zh-TW' ? 'zh-TW' : 'en'];
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'member-email-confirmation';
      panel.setAttribute('role', 'region');
      panel.setAttribute('aria-labelledby', 'member-email-title');
      panel.style.cssText = 'position:fixed;left:16px;bottom:calc(16px + env(safe-area-inset-bottom));width:min(360px,calc(100vw - 32px));box-sizing:border-box;padding:18px;border:1px solid #d6a94b;border-radius:16px;background:#111827;color:#f8fafc;box-shadow:0 8px 30px #0006;z-index:10001;font:inherit;';
      panel.innerHTML = '<h2 id="member-email-title" style="font-size:17px;font-weight:700;margin:0 0 8px"></h2><p data-body style="font-size:14px;line-height:1.5;margin:0 0 12px"></p><p data-status role="status" aria-live="polite" style="font-size:14px;line-height:1.5;color:#fcd34d;margin:0 0 12px"></p><div style="display:flex;flex-wrap:wrap;gap:10px"><button type="button" data-confirm style="border:0;border-radius:9px;padding:11px 14px;background:#fbbf24;color:#111827;font:inherit;font-weight:700;cursor:pointer"></button><button type="button" data-later style="border:1px solid #64748b;border-radius:9px;padding:11px 14px;background:transparent;color:#f8fafc;font:inherit;cursor:pointer"></button></div>';
      document.body.appendChild(panel);
      panel.querySelector('[data-later]').addEventListener('click', () => { dismissed.add(member.uid); remove(); });
      panel.querySelector('[data-confirm]').addEventListener('click', async () => {
        if (completed) { dismissed.add(member.uid); remove(); return; }
        if (busy || !member) return;
        const uid = member.uid;
        busy = true; errorCode = ''; render();
        try {
          const result = await confirmEmail(uid);
          if (member?.uid !== uid) return;
          if (result?.redirecting) return;
          if (!result?.email) throw { code: 'member/email-not-saved' };
          completed = true; member.required = false;
        } catch (error) {
          if (member?.uid === uid) errorCode = error?.code || 'unknown';
        } finally {
          if (member?.uid === uid) { busy = false; render(); }
        }
      });
    }
    panel.querySelector('h2').textContent = completed ? t.saved : t.title;
    panel.querySelector('[data-body]').textContent = completed ? '' : t.body;
    const status = completed ? '' : busy ? t.working : !errorCode ? '' :
      errorCode === 'auth/user-mismatch' ? t.mismatch :
      ['auth/popup-closed-by-user', 'auth/cancelled-popup-request'].includes(errorCode) ? t.cancelled :
      errorCode === 'member/email-not-saved' ? t.missing : t.failed;
    panel.querySelector('[data-status]').textContent = status;
    const confirm = panel.querySelector('[data-confirm]');
    confirm.textContent = completed ? t.done : busy ? t.working : t.confirm;
    confirm.disabled = busy;
    const later = panel.querySelector('[data-later]');
    later.textContent = t.later; later.disabled = busy; later.hidden = completed;
  }
  window.addEventListener('auth-user-changed', ({ detail }) => {
    const uid = detail?.isLoggedIn ? detail.user?.uid : null;
    if (!uid) { member = null; busy = false; completed = false; errorCode = ''; remove(); return; }
    if (member?.uid !== uid) { busy = false; completed = false; errorCode = ''; remove(); }
    member = { uid, required: detail.profile?.emailSyncRequired === true };
    render();
  });
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
}
