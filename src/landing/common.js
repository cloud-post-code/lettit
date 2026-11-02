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

  // waitlist (stub: swap send() for a real backend later)
  var form = document.querySelector('form.join');
  if (form) {
    var email = form.querySelector('#email'), code = form.querySelector('#code');
    var emailRow = form.querySelector('#emailRow'), codeRow = form.querySelector('#codeRow'), toggle = form.querySelector('#toggle');
    var msg = form.querySelector('#msg'), done = form.querySelector('#done'), doneText = form.querySelector('#doneText');
    var invite = false;
    function setInvite(on) { invite = on; codeRow.hidden = !on; msg.textContent = ''; toggle.textContent = on ? 'No code? Just join the waitlist' : 'Have an invite? Enter your code'; }
    toggle.addEventListener('click', function () { setInvite(!invite); (invite ? code : email).focus(); });
    document.querySelectorAll('[data-invite]').forEach(function (b) { b.addEventListener('click', function () { setInvite(true); }); });
    function ok(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
    function send(p) { return Promise.resolve(p); }
    function finish(t) { emailRow.hidden = true; codeRow.hidden = true; toggle.hidden = true; msg.textContent = ''; doneText.textContent = t; done.hidden = false; }
    form.addEventListener('submit', function (e) {
      e.preventDefault(); var v = email.value.trim();
      if (!ok(v)) { msg.textContent = 'Enter a valid email.'; email.focus(); return; }
      send({ email: v }).then(function () { finish("You're on the list."); });
    });
    form.querySelector('#codeBtn').addEventListener('click', function () {
      var v = email.value.trim(), c = code.value.trim().toUpperCase();
      if (!ok(v)) { msg.textContent = 'Add your email first.'; email.focus(); return; }
      if (c.length < 4) { msg.textContent = 'That code looks too short.'; code.focus(); return; }
      send({ email: v, code: c }).then(function () { finish('Code received. Check your inbox.'); });
    });
  }

})();
