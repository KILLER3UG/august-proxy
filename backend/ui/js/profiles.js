/* Provider Profiles (v2) */
let providerList = [];
let currentProviderId = null;
let bookmarkList = [];
function escapeHtml(text) { if (!text) return ""; var d = document.createElement("div"); d.textContent = text; return d.innerHTML; }
function showStatus(msg, cls) { var el = document.getElementById("statusMessage"); if (!el) return; el.textContent = msg; el.className = "mt-2 px-3 py-1.5 rounded-xl text-xs " + (cls || "bg-slate-100"); el.classList.remove("hidden"); setTimeout(function(){ el.classList.add("hidden"); }, 5000); }
function toggleApiKeyVisibility(id, btn) { var inp = document.getElementById(id); if (!inp) return; inp.type = inp.type === "password" ? "text" : "password"; btn.textContent = inp.type === "password" ? "\uD83D\uDC41" : "\uD83D\uDE48"; }
window.loadProviderList = async function loadProviderList() {
  var sel = document.getElementById("providerSelect"); if (!sel) return;
  try {
    var r = await fetch("/api/config/activeProvider"); var d = await r.json();
    providerList = d.providers || []; var active = d.activeProvider;
    sel.innerHTML = "<option value=''>-- Select --</option>";
    providerList.slice().sort(function(a,b){ if(a.id===active) return -1; if(b.id===active) return 1; if(a.isAvailable&&!b.isAvailable) return -1; if(!a.isAvailable&&b.isAvailable) return 1; return a.name.localeCompare(b.name); }).forEach(function(p){ var o=document.createElement("option"); o.value=p.id; o.textContent=p.name+(p.isAvailable?"":" (no key)"); if(p.id===active) o.selected=true; sel.appendChild(o); });
    var badge = document.getElementById("activeProviderBadge"); if (badge) badge.textContent = active || "None";
    renderProviderList(providerList, active); if (active) loadProviderDetails(active);
  } catch(e) { console.error('[providers] loadProviderList failed:', e); sel.innerHTML = "<option value=''>Error</option>"; }
}
function onProviderSelect() { var s=document.getElementById("providerSelect"); var id=s.value; if(!id){document.getElementById("providerDetailCard").classList.add("hidden");return;} loadProviderDetails(id); }
async function loadProviderDetails(id) { currentProviderId=id; document.getElementById("providerDetailCard").classList.remove("hidden"); try{ var r=await fetch("/api/config/provider-details?provider="+encodeURIComponent(id)); if(!r.ok)throw Error("HTTP "+r.status); renderProviderDetail(await r.json()); }catch(e){console.error(e);} }
function renderProviderDetail(data) {
  document.getElementById("providerDetailName").textContent = data.name;
  document.getElementById("providerDetailDesc").textContent = data.description || "";
  document.getElementById("providerApiModeBadge").textContent = data.apiMode;
  document.getElementById("providerAuthBadge").textContent = data.authType;
  var ec = document.getElementById("envVarStatus");
  ec.innerHTML = Object.entries(data.envStatus||{}).map(function(e){ return "<span class='inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-mono "+(e[1]?"bg-emerald-50":"bg-red-50")+"'>"+(e[1]?"\u2705":"\u274C")+" "+escapeHtml(e[0])+"</span>"; }).join("");
  document.getElementById("providerTargetUrl").value = data.configOverrides?.targetUrl || data.configOverrides?.baseUrl || data.baseUrl || "";
  var akf = document.getElementById("providerApiKey");
  var ev = data.envVars.filter(function(v){return !v.endsWith("_BASE_URL");});
  var hint = document.getElementById("providerApiKeyHint");
  var evn = ev.length > 0 ? ev[0] : null;
  var evs = evn ? data.envStatus[evn] : false;
  if (data.authType === "api_key" && evn) {
    hint.innerHTML = (evs?"\u2705 ":"\u274C ")+"<code>"+escapeHtml(evn)+"</code> "+(evs?"set. Override below.":"not set. Enter key and Save.");
    akf.disabled = false;
  } else if (data.authType==="aws_sdk") { hint.textContent="AWS SDK credentials."; akf.disabled=true; akf.value=""; }
  else if (data.authType==="oauth") { hint.textContent="OAuth auth."; akf.disabled=true; akf.value=""; }
  else { hint.textContent=""; akf.disabled=false; }
  if (data.configOverrides?.apiKey) akf.value = data.configOverrides.apiKey;
  var bc = document.getElementById("envKeyButtonContainer");
  if (bc) {
    bc.innerHTML = "";
    if (data.authType === "api_key" && evn) {
      var btn = document.createElement("button"); btn.className = "minimal-button rounded-xl px-3 py-1.5 text-xs font-semibold";
      btn.textContent = evs ? "Update in .env" : "Save Key to .env";
      btn.onclick = function(){ saveProviderEnvKey(evn); };
      bc.appendChild(btn);
    }
  }
  document.getElementById("providerModel").value = data.configOverrides?._upstreamModel || data.configOverrides?.model || "";
  document.getElementById("providerDefaultModel").textContent = "Default: "+(data.defaultModel||"none");
  document.getElementById("providerThinkingEffort").value = data.configOverrides?.thinkingEffort || "";
  var sb = document.getElementById("setActiveBtn");
  if (data.isActive) { sb.textContent = "Active"; sb.disabled = true; }
  else { sb.textContent = "Set Active"; sb.disabled = false; sb.className = "minimal-button primary flex-1 rounded-xl px-4 py-2.5 text-xs font-semibold"; }
}
async function saveProviderEnvKey(evn) { var v=document.getElementById("providerApiKey").value.trim(); if(!v){showStatus("Enter key","bg-yellow-100");return;} try{ var r=await fetch("/api/env",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:evn,value:v})}); if(!r.ok)throw Error("HTTP "+r.status); showStatus("Saved "+evn,"bg-green-100"); if(currentProviderId)loadProviderDetails(currentProviderId); }catch(e){showStatus("Failed: "+e.message,"bg-red-100");} }
async function setActiveProvider() { if(!currentProviderId)return; try{ var r=await fetch("/api/config/activeProvider",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({provider:currentProviderId})}); if(!r.ok)throw Error("HTTP "+r.status); showStatus("Active: "+currentProviderId,"bg-green-100"); loadProviderList(); }catch(e){showStatus("Failed: "+e.message,"bg-red-100");} }
async function saveProviderOverrides() { if(!currentProviderId)return; var c={}; var u=document.getElementById("providerTargetUrl").value.trim(); var k=document.getElementById("providerApiKey").value.trim(); var m=document.getElementById("providerModel").value.trim(); var e=document.getElementById("providerThinkingEffort").value; if(u)c.targetUrl=u; if(k)c.apiKey=k; if(m){c._upstreamModel=m;c.model=m;} if(e)c.thinkingEffort=e; try{ var r=await fetch("/api/config/provider-details",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({provider:currentProviderId,config:c})}); if(!r.ok)throw Error("HTTP "+r.status); showStatus("Saved overrides","bg-green-100"); }catch(e){showStatus("Failed: "+e.message,"bg-red-100");} }
async function testActiveProvider() { var btn=document.getElementById("testProviderBtn"); var o=btn.textContent; btn.textContent="Testing..."; btn.disabled=true; var u=document.getElementById("providerTargetUrl").value.trim(); var k=document.getElementById("providerApiKey").value.trim(); var m=document.getElementById("providerModel").value.trim(); if(!u){showStatus("No URL","bg-yellow-100");btn.textContent=o;btn.disabled=false;return;} try{ var r=await fetch("/ui/test",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({profile:"claude",targetUrl:u,apiKey:k,model:m||"test"})}); var d=await r.json(); showStatus(d.success?"OK":"Failed",d.success?"bg-green-100":"bg-red-100"); }catch(e){showStatus("Error: "+e.message,"bg-red-100");} btn.textContent=o; btn.disabled=false; }
function renderProviderList(providers, activeId) { var el=document.getElementById("providerListContainer"); if(!el)return; if(!providers.length){el.innerHTML="<div class='text-xs text-slate-400 italic'>No providers</div>";return;} el.innerHTML=providers.map(function(p){var a=p.id===activeId;return"<div class='flex items-center justify-between rounded-xl px-3 py-2 "+(a?"bg-emerald-50 border border-emerald-200":"bg-slate-50")+"'><span>"+(p.isAvailable?"\uD83D\uDFE2":"\u26AA")+" "+escapeHtml(p.name)+" <span class='text-[10px] text-slate-400'>"+p.apiMode+"</span>"+(a?" <strong>ACTIVE</strong>":"")+"</span><span>"+(p.isAvailable?"Ready":"No key")+"</span></div>";}).join(""); }
async function testCustomEndpoint() { var btn=event.target;var o=btn.textContent;btn.textContent="Testing...";btn.disabled=true;var u=document.getElementById("customBaseUrl").value.trim();var k=document.getElementById("customApiKey").value.trim();if(!u){showStatus("Enter URL","bg-yellow-100");btn.textContent=o;btn.disabled=false;return;} try{var r=await fetch("/ui/custom-test",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({baseUrl:u,apiKey:k,model:"test",profile:"claude"})});var d=await r.json();showStatus(d.success?"OK":"Failed",d.success?"bg-green-100":"bg-red-100");}catch(e){showStatus(e.message,"bg-red-100");} btn.textContent=o;btn.disabled=false; }
function copyActiveToAutomation() { var u=document.getElementById("providerTargetUrl"); var k=document.getElementById("providerApiKey"); var m=document.getElementById("providerModel"); if(u&&u.value)document.getElementById("automationTargetUrl").value=u.value; if(k&&k.value)document.getElementById("automationApiKey").value=k.value; if(m&&m.value)document.getElementById("automationModel").value=m.value; showStatus("Copied","bg-blue-100"); }
async function saveAutomationProvider() { var d={automationProvider:{url:document.getElementById("automationTargetUrl").value.trim(),apiKey:document.getElementById("automationApiKey").value.trim(),model:document.getElementById("automationModel").value.trim(),maxTokens:parseInt(document.getElementById("automationMaxTokens").value,10)||8192}}; if(!d.automationProvider.url)d.automationProvider=null; var r=await fetch("/ui/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)}); if(r.ok){document.getElementById("automationProviderStatus").textContent=d.automationProvider?"Saved":"Not configured";showStatus("Saved!","bg-green-100");} }
async function testAutomationProvider() { var btn=event.target;var o=btn.textContent;btn.textContent="Testing...";btn.disabled=true;var u=document.getElementById("automationTargetUrl").value.trim();var k=document.getElementById("automationApiKey").value.trim();var m=document.getElementById("automationModel").value.trim();if(!u){showStatus("Enter URL","bg-yellow-100");btn.textContent=o;btn.disabled=false;return;} try{var r=await fetch("/ui/test-automation-provider",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:u,apiKey:k,model:m})});var d=await r.json();showStatus(d.success?"Connected":"Failed",d.success?"bg-green-100":"bg-red-100");}catch(e){showStatus(e.message,"bg-red-100");} btn.textContent=o;btn.disabled=false; }
async function loadProxyAIDiagnostics() { var el=document.getElementById("proxyAICategories");if(!el)return; try{var r=await fetch("/ui/proxy-ai/status");if(!r.ok)return;var d=await r.json();if(!d)return;document.getElementById("proxyAITotal").textContent=(d.summary||{}).total||0;document.getElementById("proxyAIOk").textContent=(d.summary||{}).ok||0;document.getElementById("proxyAIWarnError").textContent=((d.summary||{}).warn||0)+((d.summary||{}).error||0);}catch(e){}}
async function runProxyAIAnalysis() { var btn=event.target;btn.textContent="Analyzing...";btn.disabled=true;var el=document.getElementById("proxyAIAnalysisOutput");if(!el)return;el.classList.remove("hidden");el.innerHTML="Running..."; try{var r=await fetch("/ui/proxy-ai/analyze",{method:"POST"});var d=await r.json();if(d.analysis)el.innerHTML="<div class='rounded-xl bg-indigo-50 p-3 text-xs'>"+d.analysis+"</div>";}catch(e){el.innerHTML=e.message;} btn.textContent="AI Analysis";btn.disabled=false; }
function onClaudeAliasChange(){}
function onThinkingEffortChange(){}
async function refreshContextWindow(p){}
async function loadModels(){try{await fetch("/ui/models");}catch(e){}}
async function loadBookmarks(){try{var r=await fetch("/ui/bookmarks");bookmarkList=await r.json();}catch(e){}}
