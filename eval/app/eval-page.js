/* anespilot.com/eval/#<link>: the preceptor's page. The link (after "#", never sent to any server) says which form,
   the student's answers and who receives it. The form is filled here and the PDF is made here; the preceptor emails it. */
(function(){
  'use strict';
  var root = document.getElementById('root');
  function msg(t, b, s){ FF.remoteMessage(root, t, b, s); }
  function clip(s, n){ return String(s == null ? '' : s).slice(0, n); }
  async function start(){
    var d;
    try{ d = await FF.decodeLink(location.hash); }
    catch(e){
      if(e && e.message === 'old') return msg('Please update your browser', 'This evaluation needs a newer browser. Open the link in Safari or Chrome, updated to the latest version.');
      return msg('Link not complete', 'This link looks cut off or damaged. Ask the student to send it again, ideally by email.', location.hash ? '' : 'The link should be long and contain a "#".');
    }
    if(!d || d.v !== 1 || !d.f || !d.to) return msg('Link not complete', 'This link could not be read. Ask the student to send it again.');
    if(d.x && Date.now() > d.x) return msg('Link expired', 'This link has expired. Ask the student to send a new one.');
    var form = null;
    if(d.f.b === 'ap_coa_d') form = {tpl: FF.coa()};
    else if(d.f.b === 'ap_coa_acp') form = {tpl: FF.acp()};
    else if(d.f.c && d.f.k){ try{ form = await FF.schoolForm(d.f.c, d.f.k); }catch(e){ form = null; } }
    if(!form || !form.tpl) return msg('Form not available', 'This school form is not available on this page. Ask the student to check with their program.');
    var p = d.p && typeof d.p === 'object' && !Array.isArray(d.p) ? d.p : {}, pre = {};
    Object.keys(p).forEach(function(k){ var v = p[k]; if(!/^[\w-]{1,60}(__c)?$/.test(k)) return;
      if(typeof v === 'boolean') pre[k] = v; else if(typeof v === 'string' && (v.indexOf('data:') !== 0 || /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(v))) pre[k] = v.slice(0, 200000); });
    document.title = (form.tpl.name || 'Clinical evaluation') + ' · AnesPilot';
    FF.mountRemote(root, {link: {id: 'L' + String(location.hash).length + '_' + String(location.hash).slice(-24).replace(/[^\w]/g, ''), formName: clip(form.tpl.name, 120), studentName: clip(d.n, 80), to: clip(d.to, 200), school: form.school || '', expires: d.x || 0},
      tpl: form.tpl, buf: form.buf || null, prefill: pre, fileName: clip(d.fn, 100)});
  }
  start();
  window.addEventListener('hashchange', function(){ location.reload(); });
})();
