/* anespilot.com/forms/: the app's Forms tab in a web browser (Android phones, Chromebooks, computers).
   It runs the same form code as the app (forms_fill.js, shared with the preceptor page /eval/) and the same sealed
   school forms, which open only with their school code. Everything is kept in this browser (localStorage). */
(function(){
  'use strict';
  var root = document.getElementById('root');
  var toastEl = null, toastT = 0;
  window.apToast = function(m){
    if(!toastEl){ toastEl = document.createElement('div'); toastEl.className = 'fp-toast'; toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); }
    toastEl.textContent = String(m || ''); toastEl.classList.add('on'); clearTimeout(toastT);
    toastT = setTimeout(function(){ toastEl.classList.remove('on'); }, 2200);
  };
  window.showSaveFailureBanner = function(m){ window.apToast(m); };
  function cat(){ return /care/i.test(location.hash) ? 'acp' : 'eval'; }
  var mounted = null;
  function show(){
    var c = cat();
    document.getElementById('fpTabEval').classList.toggle('on', c === 'eval');
    document.getElementById('fpTabAcp').classList.toggle('on', c === 'acp');
    document.getElementById('fpTabEval').setAttribute('aria-current', c === 'eval' ? 'page' : 'false');
    document.getElementById('fpTabAcp').setAttribute('aria-current', c === 'acp' ? 'page' : 'false');
    document.title = (c === 'acp' ? 'Care Plans' : 'Daily Evaluations') + ' · AnesPilot';
    if(mounted === c) return;
    try{ if(mounted && FF.teardown) FF.teardown(); }catch(e){}
    mounted = c; root.innerHTML = ''; FF.mount(root, c); window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', show);
  if(typeof FF === 'undefined'){ root.innerHTML = '<div class="card">Forms did not load. Reload the page.</div>'; return; }
  show();
})();
