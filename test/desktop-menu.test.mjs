import assert from 'node:assert/strict';
import test from 'node:test';
import {menuTemplate,menuState} from '../desktop/menu.mjs';
import {alertPreferences} from '../src/alerts.mjs';

const page={workspace:true,running:false,agent:'codex',codex:true,claude:true,gemini:true,continue:null,files:true,git:false,terminal:false,flow:false,flowLocked:false,imports:true,export:true,workspaces:[{name:'Frontend',current:true},{name:'R&D',current:false}]};
// Builds the template with recording callbacks. Items are found by label, id or role, and must be unique.
function menu(options={}){
  const sent=[],opened=[],all=[];
  const template=menuTemplate({platform:'darwin',packaged:true,version:'0.7.0',osVersion:'26.1.0',arch:'arm64',appearance:'system',keepAwake:false,state:page,send:(...command)=>sent.push(command),open:url=>opened.push(url),...options});
  const walk=items=>{for(const item of items){all.push(item);if(Array.isArray(item.submenu))walk(item.submenu);}};walk(template);
  const item=key=>{const found=all.filter(entry=>[entry.label,entry.id,entry.role].includes(key));assert.equal(found.length,1,`One menu item is ${key}`);return found[0];};
  return {template,all,sent,opened,item,roles:all.map(entry=>entry.role).filter(Boolean),labels:items=>items.map(entry=>entry.type==='separator'?'-':entry.label||entry.role)};
}
const disabled=entry=>entry.enabled===false;

test('the macOS menu bar has Codeshi, File, Edit, View, Agent, Workspace, Window and Help, with the shortcuts the page uses',()=>{
  const {template,all,item,roles,labels}=menu();
  assert.deepEqual(labels(template),['Codeshi','File','Edit','View','Agent','Workspace','windowMenu','help']);
  assert.deepEqual(labels(item('Codeshi').submenu),['about','-','Settings…','Setup Guide','-','services','-','hide','hideOthers','unhide','-','quit']);
  assert.deepEqual(labels(item('File').submenu),['New Workspace','Add Folder to Workspace…','-','Previous Chats…','Export Conversation…','Review Changes with Other Agent…','Ask a Friend…','-','close']);
  assert.deepEqual(labels(item('Edit').submenu),['undo','redo','-','cut','copy','paste','pasteAndMatchStyle','delete','selectAll','-','Find in Conversation','Find Next','Find Previous','-','Filter Workspaces','-','Speech']);
  assert.deepEqual(labels(item('View').submenu),['Show Git Activity','Show Files','Terminal','Flow Mode','Focus Message Box','-','Appearance','-','resetZoom','zoomIn','zoomOut','-','togglefullscreen']);
  assert.deepEqual(labels(item('Appearance').submenu),['System','Light','Dark','Graphite']);
  assert.deepEqual(labels(item('Agent').submenu),['Use Codex','Use Claude Code','Use Gemini','Continue Locally…','-','Stop Run','Voice Input','Continue with…','-','Keep Awake','Alerts','-','Hand Off Near Usage Limits']);
  assert.deepEqual(labels(item('Workspace').submenu),['Frontend','R&D','-','Workspace Settings…','Remove Workspace…']);
  assert.deepEqual(labels(item('help').submenu),['Codeshi Guide','Keyboard Shortcuts','-','Report a Bug','Share Design Feedback','Record Performance Trace','-','Roadmap','What’s New']);
  // These are the page's own shortcuts plus ⌘, ⌘N and ⌘G, which the page leaves to the menu.
  assert.deepEqual(Object.fromEntries(all.filter(entry=>entry.accelerator).map(entry=>[entry.label,entry.accelerator])),{'Settings…':'CmdOrCtrl+,','New Workspace':'CmdOrCtrl+N','Find in Conversation':'CmdOrCtrl+F','Find Next':'CmdOrCtrl+G','Filter Workspaces':'CmdOrCtrl+K','Show Git Activity':'CmdOrCtrl+Shift+G',Terminal:'Ctrl+`','Flow Mode':'CmdOrCtrl+Shift+F','Focus Message Box':'CmdOrCtrl+L','Stop Run':'CmdOrCtrl+.','Voice Input':'Alt+Cmd+V',Frontend:'CmdOrCtrl+1','R&D':'CmdOrCtrl+2'});
  for(const role of ['reload','forceReload','toggleDevTools'])assert(!roles.includes(role),`A packaged app leaves out ${role}.`);
  assert.deepEqual(labels(menu({packaged:false}).item('View').submenu),['Show Git Activity','Show Files','Terminal','Flow Mode','Focus Message Box','-','Appearance','-','reload','forceReload','toggleDevTools','-','resetZoom','zoomIn','zoomOut','-','togglefullscreen'],'Running from source adds Reload and Developer Tools.');
});

test('menu items enable and tick from the page, the saved appearance and Keep Awake',()=>{
  const pageItems=['Review Changes with Other Agent…','Add Folder to Workspace…','Previous Chats…','Export Conversation…','Find in Conversation','Find Next','Find Previous','Show Git Activity','Show Files','Focus Message Box','Use Codex','Use Claude Code','Stop Run','continue','Workspace Settings…','Remove Workspace…'];
  // Until the page reports, nothing that needs a workspace is offered.
  const starting=menu({state:null});
  for(const label of pageItems)assert(disabled(starting.item(label)),label);
  for(const label of ['Settings…','Setup Guide','New Workspace','Filter Workspaces','Keep Awake','System','Light','Dark','Graphite','Codeshi Guide','Report a Bug'])assert(!disabled(starting.item(label)),label);
  assert.deepEqual(starting.labels(starting.item('Workspace').submenu),['Workspace Settings…','Remove Workspace…']);
  const open=menu();
  for(const label of pageItems.filter(label=>label!=='Stop Run'&&label!=='continue'))assert(!disabled(open.item(label)),label);
  assert(disabled(open.item('Stop Run')),'Stop Run is offered only during a run.');
  const running=menu({state:{...page,running:true}});
  assert(!disabled(running.item('Stop Run')));
  for(const label of ['Add Folder to Workspace…','Remove Workspace…'])assert(disabled(running.item(label)),`${label} waits for the run to finish.`);
  assert.deepEqual(['Use Codex','Use Claude Code'].map(label=>disabled(menu({state:{...page,claude:false}}).item(label))),[false,true],'An agent the page cannot select is not offered.');
  assert.equal(menu({state:{...page,imports:false,export:false}}).item('Previous Chats…').enabled,false);
  assert.equal(menu({state:{...page,imports:false,export:false}}).item('Export Conversation…').enabled,false);
  // The agent and appearance are radio choices; files, Git activity, Keep Awake and the open workspace are ticks.
  assert.deepEqual(['Use Codex','Use Claude Code'].map(label=>[open.item(label).type,open.item(label).checked]),[['radio',true],['radio',false]]);
  const claude=menu({state:{...page,agent:'claude'}});assert.deepEqual(['Use Codex','Use Claude Code'].map(label=>claude.item(label).checked),[false,true]);
  for(const [appearance,checked] of [['system','System'],['light','Light'],['dark','Dark'],['graphite','Graphite']]){const shown=menu({appearance});assert.deepEqual(['System','Light','Dark','Graphite'].map(label=>shown.item(label).checked),['System','Light','Dark','Graphite'].map(label=>label===checked),appearance);assert.equal(shown.item(checked).type,'radio');}
  assert.deepEqual(['Show Files','Show Git Activity'].map(label=>[open.item(label).type,open.item(label).checked]),[['checkbox',true],['checkbox',false]]);
  const toggled=menu({state:{...page,files:false,git:true}});assert.deepEqual(['Show Files','Show Git Activity'].map(label=>toggled.item(label).checked),[false,true]);
  assert.deepEqual([open.item('Keep Awake').type,open.item('Keep Awake').checked,menu({keepAwake:true}).item('Keep Awake').checked],['checkbox',false,true]);
  assert.deepEqual(['Frontend','R&D'].map(label=>[open.item(label).type,open.item(label).checked]),[['checkbox',true],['checkbox',false]]);
  // Continue names the agent the page's Continue button would use.
  assert.deepEqual([open.item('continue').label,disabled(open.item('continue'))],['Continue with…',true]);
  for(const [agent,label] of [['codex','Continue with Codex'],['claude','Continue with Claude Code']]){const offered=menu({state:{...page,continue:agent}}).item('continue');assert.deepEqual([offered.label,disabled(offered)],[label,false]);}
});

test('page items and in-app release notes send commands, and external Help links open fixed GitHub pages',()=>{
  const {all,sent,opened,item}=menu();
  const commands={'Review Changes with Other Agent…':['review'],'Ask a Friend…':['ask-friend'],'Settings…':['settings'],'Setup Guide':['setup-guide'],'New Workspace':['new-workspace'],'Add Folder to Workspace…':['add-folder'],'Previous Chats…':['previous-chats'],'Export Conversation…':['export'],'Find in Conversation':['find'],'Find Next':['find-next'],'Find Previous':['find-previous'],'Filter Workspaces':['filter-workspaces'],'Show Git Activity':['git'],'Show Files':['files'],'Focus Message Box':['focus-message'],System:['appearance','system'],Light:['appearance','light'],Dark:['appearance','dark'],Graphite:['appearance','graphite'],'Use Codex':['agent','codex'],'Use Claude Code':['agent','claude'],'Stop Run':['stop'],continue:['continue'],'Keep Awake':['keep-awake'],Frontend:['workspace',1],'R&D':['workspace',2],'Workspace Settings…':['workspace-settings'],'Remove Workspace…':['remove-workspace']};
  commands['What’s New']=['whats-new'];
  commands.Terminal=['terminal'];
  commands['Flow Mode']=['flow'];
  commands['Voice Input']=['voice'];
  commands['Use Gemini']=['agent','gemini'];
  commands['Continue Locally…']=['local-models'];
  commands['Alert Settings…']=['alert-settings'];
  for(const [label,command] of Object.entries(commands)){sent.length=0;item(label).click();assert.deepEqual(sent,[command],label);}
  assert.deepEqual(opened,[]);
  const repository='https://github.com/AhmedNavaz/codeshi';
  const pages={'Codeshi Guide':`${repository}/blob/main/docs/guide.md`,'Keyboard Shortcuts':`${repository}/blob/main/docs/guide.md#keyboard-shortcuts`,'Report a Bug':`${repository}/issues/new?template=bug_report.yml&version=0.7.0&system=macOS+26.1.0%2C+Apple+Silicon`,'Share Design Feedback':`${repository}/issues/new?template=ux_feedback.yml`,Roadmap:`${repository}/blob/main/ROADMAP.md`};
  for(const [label,url] of Object.entries(pages)){opened.length=0;item(label).click();assert.deepEqual(opened,[url],label);}
  // The five alert and status switches, the five handoff choices and Record Performance Trace are handled by the desktop app itself and tested separately.
  assert.equal(all.filter(entry=>entry.click).length,Object.keys(commands).length+Object.keys(pages).length+11,'Every other item is a standard role.');
  for(const entry of all)assert(!(entry.role&&entry.click),`${entry.role} keeps its native behaviour.`);
  const intel=[];menu({arch:'x64',osVersion:'15.7.1',open:url=>intel.push(url)}).item('Report a Bug').click();assert.match(intel[0],/&system=macOS\+15\.7\.1%2C\+Intel$/);
});

for(const platform of ['win32','linux'])test(`on ${platform} the menus have no app menu: Settings and Exit join File, Setup Guide and About join Help, and & stays literal`,()=>{
  const {template,item,roles,labels}=menu({platform});
  assert.deepEqual(labels(template),['File','Edit','View','Agent','Workspace','windowMenu','help']);
  assert.deepEqual(labels(item('File').submenu),['New Workspace','Add Folder to Workspace…','-','Previous Chats…','Export Conversation…','Review Changes with Other Agent…','Ask a Friend…','-','Settings…','-','close','quit']);
  assert.deepEqual(labels(item('Edit').submenu),['undo','redo','-','cut','copy','paste','delete','-','selectAll','-','Find in Conversation','Find Next','Find Previous','-','Filter Workspaces']);
  assert.deepEqual(labels(item('help').submenu),['Codeshi Guide','Keyboard Shortcuts','Setup Guide','-','Report a Bug','Share Design Feedback','Record Performance Trace','-','Roadmap','What’s New','-','about']);
  for(const role of ['services','hide','hideOthers','unhide','pasteAndMatchStyle'])assert(!roles.includes(role),role);
  // & marks a keyboard mnemonic in Windows and Linux menus, so a workspace name doubles it to show it.
  assert.equal(item('workspace-2').label,'R&&D');assert.equal(menu().item('workspace-2').label,'R&D');
  const opened=[];menu({platform,osVersion:'10.0.26100',arch:'x64',open:url=>opened.push(url)}).item('Report a Bug').click();
  assert.match(opened[0],new RegExp(`&system=${platform==='win32'?'Windows':'Linux'}\\+10\\.0\\.26100%2C\\+x64$`));
});

test('menu state from the page is used only in the expected shape',()=>{
  assert.deepEqual(menuState(page),page);
  const nine=Array.from({length:9},(_,index)=>({name:'Workspace '+index,current:index===0}));
  assert.deepEqual(menuState({...page,continue:'claude',workspaces:nine}),{...page,continue:'claude',workspaces:nine});
  const {files,...missing}=page;
  for(const wrong of [null,undefined,'state',[],{},missing,{...page,extra:true},{...page,running:'yes'},{...page,agent:'invalid'},{...page,continue:'invalid'},{...page,continue:false},{...page,workspaces:{}},{...page,workspaces:[...nine,{name:'One more',current:false}]},{...page,workspaces:[{name:'',current:false}]},{...page,workspaces:[{name:'x'.repeat(121),current:false}]},{...page,workspaces:[{name:7,current:false}]},{...page,workspaces:[{name:'Frontend',current:1}]},{...page,workspaces:[{name:'Frontend',current:false,path:'/'}]},{...page,workspaces:[null]}])
    assert.equal(menuState(wrong),null,JSON.stringify(wrong));
  const copy=menuState(page);assert.notEqual(copy.workspaces,page.workspaces,'The state is copied, not kept by reference.');
});

test('the Agent menu has one Alerts menu that turns each way of alerting on or off, and opens their settings',()=>{
  const changes=[],open=menu({notifications:alertPreferences({sound:{on:false}}),setNotifications:patch=>changes.push(patch)});
  assert.deepEqual(open.labels(open.item('Alerts').submenu),['Banners','Sounds','Bounce the Dock Icon','Badge on the Dock Icon','Status in the Menu Bar','-','Alert Settings…']);
  const banners=open.item('Banners'),sounds=open.item('Sounds');
  assert.deepEqual([banners.type,banners.checked,sounds.checked,disabled(sounds)],['checkbox',true,false,false]);
  banners.click();sounds.click();open.item('Bounce the Dock Icon').click();open.item('Status in the Menu Bar').click();
  assert.deepEqual(changes,[{banner:{on:false}},{sound:{on:true}},{bounce:{on:false}},{statusItem:false}]);
  open.item('Alert Settings…').click();assert.deepEqual(open.sent,[['alert-settings']],'Alert Settings… opens the Alerts section of Settings.');
  assert(!menu().all.some(entry=>/^(Notify When|Play Sounds|Show Alerts Near|Show Status in Menu Bar)/.test(entry.label||'')),'The separate alert items are gone.');
});

test('the Agent menu chooses when a handoff is offered near a usage limit, and whether it may switch to subscription agents on its own',()=>{
  const changes=[],open=menu({handoff:{threshold:90,automatic:false},setHandoff:patch=>changes.push(patch)});
  assert.deepEqual(open.labels(open.item('Hand Off Near Usage Limits').submenu),['Never Offer','Offer at 80%','Offer at 90%','Offer at 95%','-','Hand Off Automatically to Subscription Agents']);
  assert.deepEqual(['Never Offer','Offer at 80%','Offer at 90%','Offer at 95%'].map(label=>[open.item(label).type,open.item(label).checked]),[['radio',false],['radio',false],['radio',true],['radio',false]]);
  const automatic=open.item('Hand Off Automatically to Subscription Agents');
  assert.deepEqual([automatic.type,automatic.checked,disabled(automatic)],['checkbox',false,false]);
  open.item('Never Offer').click();open.item('Offer at 80%').click();automatic.click();
  assert.deepEqual(changes,[{threshold:0},{threshold:80},{automatic:true}]);
  assert.equal(disabled(menu({handoff:{threshold:0,automatic:true}}).item('Hand Off Automatically to Subscription Agents')),true,'Automatic handoff needs offers to be on.');
});

test('Help records a performance trace in the desktop app, in the installed app too, and shows that it is recording',()=>{
  let recorded=0;
  const {item,labels,sent,opened}=menu({recordTrace:()=>recorded++});
  const help=labels(item('help').submenu);
  assert.equal(help[help.indexOf('Share Design Feedback')+1],'Record Performance Trace','It sits with Report a Bug and Share Design Feedback.');
  item('Record Performance Trace').click();
  assert.equal(recorded,1);
  assert.deepEqual([sent,opened],[[],[]],'The desktop app records it; the page is not asked and nothing opens.');
  const busy=menu({tracing:true});
  assert.equal(busy.item('Recording Performance Trace…').enabled,false,'While it records, the item says so and cannot start a second one.');
  assert(!busy.all.some(entry=>entry.label==='Record Performance Trace'));
});

test('the installed app offers Check for Updates… after About, which asks the page to check and show the answer',()=>{
  const {item,sent,labels}=menu({updates:true});
  assert.deepEqual(labels(item('Codeshi').submenu).slice(0,3),['about','Check for Updates…','-']);
  item('check-updates').click();
  assert.deepEqual(sent,[['check-updates']]);
  assert(!menu().all.some(entry=>entry.label==='Check for Updates…'),'A copy that cannot update itself, such as one run from source, leaves it out.');
});

test('other systems flash the taskbar button instead of bouncing an icon, with no Dock badge, and Windows has its notification area',()=>{
  const changes=[],windows=menu({platform:'win32',setNotifications:patch=>changes.push(patch)});
  assert.deepEqual(windows.labels(windows.item('Alerts').submenu),['Banners','Sounds','Flash the Taskbar Button','Status in the Notification Area','-','Alert Settings…']);
  windows.item('Status in the Notification Area').click();assert.deepEqual(changes,[{statusItem:false}]);
  assert(!windows.all.some(entry=>/Menu Bar|Dock/.test(entry.label||'')));
  const linux=menu({platform:'linux'});
  assert.deepEqual(linux.labels(linux.item('Alerts').submenu),['Banners','Sounds','Flash the Taskbar Button','-','Alert Settings…']);
});

test('Voice Input is in the Agent menu on macOS, where speech is recognized on the Mac, and nowhere else yet',()=>{
  const mac=menu();assert.equal(mac.item('Voice Input').accelerator,'Alt+Cmd+V');mac.item('Voice Input').click();assert.deepEqual(mac.sent,[['voice']]);
  assert(!menu({platform:'win32'}).all.some(entry=>entry.label==='Voice Input'));
});

test('Flow disables the native Terminal menu entry', () => {
  assert.equal(menu({ state: { ...page, flow: true } }).item('Terminal').enabled, false);
});

test('Flow disables choosing an agent by hand, since routing chooses for each message', () => {
  assert.equal(menu().item('Use Codex').enabled, true);
  for (const name of ['Use Codex', 'Use Claude Code', 'Use Gemini']) assert.equal(menu({ state: { ...page, flow: true } }).item(name).enabled, false, name);
});


test('Flow mode changes wait for workspace activity, including other tasks', () => {
  assert.equal(menu({ state: { ...page, flowLocked: true } }).item('Flow Mode').enabled, false);
  assert.equal(menu({ state: { ...page, running: true } }).item('Flow Mode').enabled, false);
  assert.equal(menu({ state: { ...page, flow: true, flowLocked: true } }).item('Flow Mode').enabled, false);
});
