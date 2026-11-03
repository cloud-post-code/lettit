/* Shared behaviour: logos, reveal-on-scroll, waitlist stub */
(function () {
  // logos: any element with data-logo gets the image; falls back to the initial
  var L = window.LOGOS || {};
  document.querySelectorAll('[data-logo]').forEach(function (c) {
    var src = L[c.getAttribute('data-logo')];
    var img = c.querySelector('img'), ini = c.querySelector('.ini');
    if (src && img) { img.src = src; img.hidden = false; if (ini) ini.hidden = true; }
  });

  // reveal
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.1 });
    document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });
  } else { document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('in'); }); }

  // waitlist: POST /api/waitlist {email, communities, code}; the list is read at /admin
  var form = document.querySelector('form.join');
  if (form) {
    var email = form.querySelector('#email'), code = form.querySelector('#code');
    var emailRow = form.querySelector('#emailRow'), codeRow = form.querySelector('#codeRow'), toggle = form.querySelector('#toggle');
    var msg = form.querySelector('#msg'), done = form.querySelector('#done'), doneText = form.querySelector('#doneText');
    var buttons = form.querySelectorAll('button.btn');
    var invite = false, busy = false;
    function setInvite(on) { invite = on; codeRow.hidden = !on; msg.textContent = ''; toggle.textContent = on ? 'No code? Just join the waitlist' : 'Have an invite? Enter your code'; }
    toggle.addEventListener('click', function () { setInvite(!invite); (invite ? code : email).focus(); });
    document.querySelectorAll('[data-invite]').forEach(function (b) { b.addEventListener('click', function () { setInvite(true); }); });
    function ok(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
    function picks() { return Array.prototype.map.call(document.querySelectorAll('.picks button.on'), function (b) { return b.textContent.trim(); }); }
    function lock(on) { busy = on; Array.prototype.forEach.call(buttons, function (b) { b.disabled = on; }); }
    function send(p) {
      return fetch('/api/waitlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p), credentials: 'same-origin' })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('Something went wrong (' + r.status + ').')); return j; }); });
    }
    function finish(t) { emailRow.hidden = true; codeRow.hidden = true; toggle.hidden = true; msg.textContent = ''; doneText.textContent = t; done.hidden = false; }
    function fail(e) { lock(false); msg.textContent = (e && e.message) || "Couldn't save that. Try again in a moment."; }
    form.addEventListener('submit', function (e) {
      e.preventDefault(); if (busy) return; var v = email.value.trim();
      if (!ok(v)) { msg.textContent = 'Enter a valid email.'; email.focus(); return; }
      lock(true); msg.textContent = 'Saving…';
      send({ email: v, communities: picks() }).then(function (j) { finish(j.already ? "You're already on the list. We'll be in touch." : "You're on the list."); }).catch(fail);
    });
    form.querySelector('#codeBtn').addEventListener('click', function () {
      if (busy) return; var v = email.value.trim(), c = code.value.trim().toUpperCase();
      if (!ok(v)) { msg.textContent = 'Add your email first.'; email.focus(); return; }
      if (c.length < 4) { msg.textContent = 'That code looks too short.'; code.focus(); return; }
      lock(true); msg.textContent = 'Saving…';
      send({ email: v, communities: picks(), code: c }).then(function () { finish("Code received. You're on the list and we'll be in touch."); }).catch(fail);
    });
  }

})();
