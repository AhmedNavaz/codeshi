import {app,BaseWindow,BrowserWindow,Menu,Notification,Tray,WebContentsView,dialog,ipcMain,nativeImage,nativeTheme,screen,session,shell,powerSaveBlocker} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {createRelayServer} from '../src/server.mjs';
import {migrateLegacyData,preferredUserData} from './storage.mjs';
import {createReleaseState} from './updates.mjs';
import {createKeepAwake} from './keep-awake.mjs';
import {createUpdater,updateBuild,bundleLocation} from './updater.mjs';
import {prepareHelper} from '../src/terminal.mjs';
import {helperPath} from '../src/voice.mjs';
import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import os from 'node:os';
import http from 'node:http';
import {createAppearance} from './appearance.mjs';
import {menuTemplate,menuState} from './menu.mjs';
import {statusSnapshot,statusTitle,statusMenu,alertChannels} from './status.mjs';
import {createOverlay} from './overlay.mjs';
import {createPreview} from './preview.mjs';
import {APP_ID,ensureStartMenuShortcut} from './windows.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const smoke=process.argv.includes('--smoke-test');
// A copy run from source is a separate app from the installed one: its own name, data folder and single-instance
// lock. Both run side by side in their own windows, and testing from source never opens or changes the installed
// app's workspaces and conversations.
const development=!app.isPackaged;
if(development)app.setName('Throughline Dev');
if(process.env.AI_RELAY_DESKTOP_DATA) app.setPath('userData',path.resolve(process.env.AI_RELAY_DESKTOP_DATA));
else if(development) app.setPath('userData',path.join(app.getPath('appData'),'Throughline Dev'));
else app.setPath('userData',preferredUserData(app.getPath('appData'),app.getPath('userData')));
// Windows ties notifications and the taskbar entry to this ID (see windows.mjs).
if(process.platform==='win32'&&!development)app.setAppUserModelId(APP_ID);
const primary=app.requestSingleInstanceLock();
let relay,win,origin,keepAwake,updater,tray=null,overlay=null,preview=null,quitting=false;
if(!primary) app.quit();
else {
  app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.show();win.focus();}});
  app.on('before-quit',event=>{if(relay&&!quitting){event.preventDefault();quitting=true;keepAwake?.dispose();updater?.dispose();relay.close().finally(()=>app.quit());}});
  app.on('will-quit',()=>{keepAwake?.dispose();overlay?.dispose();preview?.dispose();tray?.destroy();tray=null;});
  app.on('window-all-closed',()=>app.quit());
  app.whenReady().then(async()=>{
    if(process.platform==='darwin'&&!app.isPackaged) app.dock?.setIcon(path.join(root,'assets','icon.png'));
    if(process.platform==='win32'&&!development&&!smoke){try{ensureStartMenuShortcut({shell,programs:path.join(app.getPath('appData'),'Microsoft','Windows','Start Menu','Programs'),target:process.execPath});}catch(error){console.warn('Windows notifications need a Start menu shortcut:',error.message);}}
    const data=path.join(app.getPath('userData'),'relay-data');
    migrateLegacyData(process.env.AI_RELAY_LEGACY_DATA_DIR || path.join(root,'.data'),data);
    const releases=createReleaseState({filename:path.join(app.getPath('userData'),'install.json'),version:app.getVersion(),changelog:fs.readFileSync(path.join(root,'CHANGELOG.md'),'utf8'),existing:['projects.json','settings.json'].some(name=>fs.existsSync(path.join(data,name)))});
    const token=randomBytes(32).toString('hex');
    const appearance=createAppearance({nativeTheme,onBackground:color=>{if(win&&!win.isDestroyed())win.setBackgroundColor(color);}});
    // The menu bar shows what the page last reported, the saved appearance and Keep Awake.
    let page=null,awake=false;
    const updateMenu=()=>Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate({platform:process.platform,packaged:app.isPackaged,updates:Boolean(updater?.state().supported),version:app.getVersion(),osVersion:process.getSystemVersion(),arch:process.arch,state:page,appearance:relay.getAppearancePreference(),keepAwake:awake,notifications:relay.getNotificationPreferences(),setNotifications:patch=>{relay.setNotificationPreferences(patch);updateMenu();syncStatus();},handoff:relay.getHandoffPreferences(),setHandoff:patch=>{relay.setHandoffPreferences(patch);updateMenu();},open:url=>shell.openExternal(url),
      // A clicked checkbox or radio item ticks itself, so the menu is rebuilt to show the page's answer instead.
      send:(...command)=>{if(win&&!win.isDestroyed())win.webContents.send('relay:menu-command',...command);updateMenu();}})));
    app.setAboutPanelOptions({applicationName:'Throughline',applicationVersion:app.getVersion(),version:''});
    // Work that finishes or needs an answer while the person is elsewhere is reported outside the window. While the
    // window is in front the page already shows it. The Dock badge counts what happened since the window was last in
    // front and needs no permission; an approval bounces the Dock until the app is opened. A system notification is
    // added where macOS allows one: an app without a Developer ID signature is refused, so the Dock always carries it.
    // On Windows and Linux the taskbar button flashes instead of the Dock bouncing.
    let attention=0,notificationsRefused=false;
    // Brings the window forward, opening a workspace or an approval's request card. Nothing is answered on the way.
    function openTarget(target){
      if(!win||win.isDestroyed())return;
      if(win.isMinimized())win.restore();win.show();win.focus();app.focus?.({steal:true});
      if(target?.projectId)win.webContents.send('relay:menu-command',target.approvalId?'open-approval':'open-workspace',target.approvalId?{projectId:target.projectId,approvalId:target.approvalId}:target.projectId);
    }
    // Turned off in the Agent menu, only the Dock badge and the sidebar's approval count remain. With alerts near the
    // top of the screen turned on (#13), they take the place of the system banner, so nothing is announced twice.
    function notify({kind,title,body,projectId,projectName,approvalId}){
      const preferences=relay.getNotificationPreferences(),channels=alertChannels({focused:Boolean(win&&!win.isDestroyed()&&win.isFocused()),preferences,overlayAvailable:Boolean(overlay)});
      if(!channels.badge)return;
      attention++;app.dock?.setBadge(String(attention));
      if(!channels.bounce)return;
      app.dock?.bounce(kind==='approval'?'critical':'informational');
      if(process.platform!=='darwin'&&win&&!win.isDestroyed())win.flashFrame(true);
      if(channels.overlay){overlay.show({kind,title,body,projectId,projectName,approvalId});return;}
      if(notificationsRefused||!Notification.isSupported())return;
      const notice=new Notification({title:projectName?`${title} · ${projectName}`:title,body:String(body||'').slice(0,240),silent:kind==='started'||!preferences.sound});
      // An approval opens its own request card; it is never answered from the notification.
      notice.on('click',()=>openTarget(projectId?{projectId,approvalId:kind==='approval'?approvalId:null}:null));
      notice.on('failed',(_event,error)=>{notificationsRefused=true;console.warn('macOS did not show a Throughline notification:',error);});
      notice.show();
    }
    const statusIcons=process.platform==='darwin'?{idle:nativeImage.createFromPath(path.join(root,'assets','status','StatusTemplate.png')),attention:nativeImage.createFromPath(path.join(root,'assets','status','StatusAttentionTemplate.png'))}:null;
    let statusTimer=null;
    function scheduleStatus(){if(!statusTimer)statusTimer=setTimeout(syncStatus,400);}
    function setStatusPreferences(patch){relay.setNotificationPreferences(patch);updateMenu();syncStatus();}
    function syncStatus(){
      clearTimeout(statusTimer);statusTimer=null;
      if(process.platform!=='darwin'||!relay||quitting)return;
      const preferences=relay.getNotificationPreferences();
      if(!preferences.statusItem){tray?.destroy();tray=null;return;}
      const snapshot=statusSnapshot(relay.registry);
      if(!tray){for(const icon of Object.values(statusIcons))icon.setTemplateImage(true);tray=new Tray(statusIcons.idle);tray.setToolTip('Throughline');}
      tray.setImage(snapshot.attention?statusIcons.attention:statusIcons.idle);
      tray.setTitle(statusTitle(snapshot),{fontType:'monospacedDigit'});
      tray.setContextMenu(Menu.buildFromTemplate(statusMenu(snapshot,{keepAwake:keepAwake?.getState()||{enabled:false,active:false},overlay:preferences.overlay,open:openTarget,show:()=>openTarget(null),setKeepAwake:value=>keepAwake?.setEnabled(value),setOverlay:value=>setStatusPreferences({overlay:value}),hide:()=>setStatusPreferences({statusItem:false}),quit:()=>app.quit()})));
      overlay?.reconcile(snapshot);
    }
    async function start(){
      relay=createRelayServer({dataRoot:data,accessToken:token,onAppearance:preference=>{appearance.set(preference);updateMenu();},onHandoff:()=>updateMenu(),onNotify:notify});
      appearance.set(relay.getAppearancePreference());
      keepAwake=createKeepAwake({registry:relay.registry,blocker:powerSaveBlocker,enabled:relay.getKeepAwakePreference(),save:relay.setKeepAwakePreference,onChange:state=>{awake=state.enabled;if(win&&!win.isDestroyed())win.webContents.send('relay:keep-awake-changed',state);updateMenu();scheduleStatus();}});
      await new Promise((resolve,reject)=>{relay.server.once('error',reject);relay.server.listen(0,'127.0.0.1',resolve);});
      origin=`http://127.0.0.1:${relay.server.address().port}`;
    }
    await start();
    // Throughline restarts to update only when no agent is working and no queued prompt is about to start.
    const busy=()=>[...relay.registry.brokers.values()].some(({broker})=>broker.running||broker.backgroundReview||[...broker.conversations.values()].some(c=>c.queue?.length&&!c.queuePaused));
    updater=createUpdater({version:app.getVersion(),build:updateBuild({arch:process.arch,translated:app.runningUnderARM64Translation}),location:bundleLocation(process.execPath),directory:path.join(app.getPath('userData'),'updates'),supported:app.isPackaged&&!smoke,busy,quit:()=>app.quit(),onState:state=>{if(win&&!win.isDestroyed())win.webContents.send('relay:update-state',state);}});
    relay.registry.on('update',()=>setTimeout(()=>updater.idle(),0));
    // Live status on the Mac (#13): the menu bar item follows every workspace's runs, approvals and waits.
    if(process.platform==='darwin'){
      overlay=createOverlay({BrowserWindow,screen,ipcMain,root,open:openTarget});
      relay.registry.on('update',scheduleStatus);relay.registry.on('projects',scheduleStatus);
    }
    updateMenu();syncStatus();
    win=new BrowserWindow({width:1440,height:1000,minWidth:900,minHeight:680,show:false,title:'Throughline',icon:path.join(root,'assets','icon.png'),backgroundColor:appearance.background(),...(process.platform==='darwin'?{titleBarStyle:'hiddenInset',trafficLightPosition:{x:14,y:13}}:{}),webPreferences:{preload:path.join(root,'desktop','preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,additionalArguments:[...(development?['--relay-channel=development']:[]),`--relay-token=${token}`]}});
    win.on('focus',()=>{attention=0;app.dock?.setBadge('');if(process.platform!=='darwin')win.flashFrame(false);});
    // The window list and the app switcher tell the two copies apart.
    if(development)win.on('page-title-updated',(event,title)=>{event.preventDefault();win.setTitle(`${title} (Development)`);});
    if(!smoke) win.once('ready-to-show',()=>win.show());
    const trusted=event=>event.sender===win.webContents && event.senderFrame===win.webContents.mainFrame && event.senderFrame.url.startsWith(origin+'/');
    ipcMain.handle('relay:keep-awake:get',event=>{if(!trusted(event))throw Error('Untrusted renderer');return keepAwake.getState();});
    ipcMain.handle('relay:keep-awake:set',(event,enabled)=>{if(!trusted(event))throw Error('Untrusted renderer');return keepAwake.setEnabled(enabled);});
    ipcMain.handle('relay:launch',event=>{if(!trusted(event))throw Error('Untrusted renderer');return releases.get();});
    ipcMain.handle('relay:acknowledge-update',event=>{if(!trusted(event))throw Error('Untrusted renderer');return releases.acknowledge();});
    ipcMain.handle('relay:update:get',event=>{if(!trusted(event))throw Error('Untrusted renderer');return updater.state();});
    ipcMain.handle('relay:update:check',event=>{if(!trusted(event))throw Error('Untrusted renderer');return updater.check();});
    ipcMain.handle('relay:update:install',event=>{if(!trusted(event))throw Error('Untrusted renderer');return updater.install();});
    ipcMain.handle('relay:update:cancel',event=>{if(!trusted(event))throw Error('Untrusted renderer');return updater.cancel();});
    ipcMain.handle('relay:update:skip',(event,version)=>{if(!trusted(event))throw Error('Untrusted renderer');return updater.skip(version);});
    ipcMain.handle('relay:update:automatic',(event,enabled)=>{if(!trusted(event))throw Error('Untrusted renderer');return updater.setAutomatic(enabled);});
    ipcMain.on('relay:menu-state',(event,input)=>{if(!trusted(event))return;const next=menuState(input);if(next){page=next;updateMenu();}});
    // Point and tell (#19): the workspace's app in a preview window; an element picked there goes to the message box.
    const previewPicks=[];
    preview=createPreview({BaseWindow,WebContentsView,session,ipcMain,shell,root,background:()=>appearance.background(),
      folders:id=>{try{return id?relay.registry.get(id).folders.map(folder=>({name:folder.displayName||folder.name,path:folder.path})):[];}catch{return [];}},
      onPick:pick=>{for(const resolve of previewPicks.splice(0))resolve(pick);if(!win||win.isDestroyed())return;if(pick.focus){if(win.isMinimized())win.restore();win.show();win.focus();win.webContents.send('relay:menu-command','focus-message');return;}win.webContents.send('relay:preview-pick',{projectId:pick.projectId,text:pick.text,image:pick.image});}});
    ipcMain.handle('relay:preview:open',async(event,input)=>{if(!trusted(event))throw Error('Untrusted renderer');const project=relay.registry.get(String(input?.projectId||''));return preview.open({projectId:project.id,url:input?.url,workspace:project.name});});
    ipcMain.handle('relay:pick-folder',async event=>{if(!trusted(event))throw Error('Untrusted renderer');const choice=await dialog.showOpenDialog(win,{properties:['openDirectory']});return choice.canceled?null:choice.filePaths[0];});
    ipcMain.handle('relay:open-external',async(event,input)=>{if(!trusted(event))throw Error('Untrusted renderer');const url=new URL(input);if(url.username||url.password||(url.protocol!=='https:' && !(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw Error('Only HTTPS or local test links without credentials may open');await shell.openExternal(url.href);return true;});
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(origin+'/'))event.preventDefault();});
    // Only clipboard writes (Copy buttons) are granted; every other permission stays denied.
    win.webContents.session.setPermissionRequestHandler((_contents,permission,callback)=>callback(permission==='clipboard-sanitized-write'));
    await win.loadURL(origin);
    if(smoke){
      const blockerId=powerSaveBlocker.start('prevent-display-sleep');
      const nativeAwake=powerSaveBlocker.isStarted(blockerId);powerSaveBlocker.stop(blockerId);
      if(!nativeAwake||powerSaveBlocker.isStarted(blockerId))throw Error('Native display sleep blocker check failed.');
      const result=await win.webContents.executeJavaScript(`({title:document.title,isolated:typeof require==='undefined',bridge:typeof window.relayDesktop?.pickFolder==='function',launchBridge:typeof window.relayDesktop?.getLaunchState==='function'&&typeof window.relayDesktop?.acknowledgeUpdate==='function',updateBridge:typeof window.relayDesktop?.getUpdateState==='function'&&typeof window.relayDesktop?.installUpdate==='function'&&typeof window.relayUpdater?.checkNow==='function',keepAwakeBridge:typeof window.relayDesktop?.getKeepAwake==='function'&&typeof window.relayDesktop?.setKeepAwake==='function'&&typeof window.relayDesktop?.onKeepAwakeChanged==='function',usagePopover:typeof document.getElementById('usage-dialog')?.showPopover==='function',ui:!!document.getElementById('ask-friend'),configuration:typeof window.relayUI?.setConfiguration==='function',models:!!document.getElementById('model-select'),git:!!document.getElementById('open-git'),imports:!!document.getElementById('import-dialog')})`);
      result.nativeAwake=nativeAwake;
      result.review=await win.webContents.executeJavaScript(`typeof window.relayReviews?.open==='function'&&!!document.getElementById('review-dialog')`);
      result.local=await win.webContents.executeJavaScript(`typeof window.relayLocal?.open==='function'&&!!document.getElementById('local-dialog')&&!!document.getElementById('open-local')`);
      result.modelPicker=await win.webContents.executeJavaScript(`typeof window.relayModelPicker?.open==='function'&&!!document.getElementById('model-picker-popover')`);
      result.permissions=await win.webContents.executeJavaScript(`['ask','auto'].every(value=>!!document.querySelector('#approval-select option[value="'+value+'"]'))`);
      result.geminiImports=await win.webContents.executeJavaScript(`!!document.querySelector('#import-provider-select option[value="gemini"]')`);
      // The terminal's native module loads in this build and runs a shell, and its renderer loaded under the page's policy.
      result.terminal=await new Promise(resolve=>{try{prepareHelper();const shell=createRequire(import.meta.url)('node-pty').spawn(...process.platform==='win32'?[process.env.ComSpec||'cmd.exe',['/d','/c','echo terminal-ok']]:['/bin/sh',['-c','echo terminal-ok']],{name:'xterm-256color',cols:80,rows:24,cwd:os.tmpdir(),env:process.platform==='win32'?process.env:{PATH:'/usr/bin:/bin'}});let output='';shell.onData(data=>{output+=data;});shell.onExit(()=>resolve(output.includes('terminal-ok')));setTimeout(()=>resolve(false),5000);}catch(error){console.error(error);resolve(false);}});
      // Voice input loaded, and in a packaged Mac build its speech helper is inside and answers without asking for anything.
      result.voiceUI=await win.webContents.executeJavaScript(`typeof window.relayVoice?.toggle==='function'&&!!document.getElementById('voice-input')`);
      // The status item shows in the menu bar, and an alert panel loads and shows without taking focus (#13).
      if(process.platform==='darwin'){
        result.statusItem=Boolean(tray&&!tray.isDestroyed()&&!statusIcons.idle.isEmpty()&&!statusIcons.attention.isEmpty()&&statusMenu(statusSnapshot(relay.registry)).length>0);
        overlay.show({kind:'finished',title:'Task finished',body:'Smoke test',projectName:'Smoke'});
        const panel=BrowserWindow.getAllWindows().find(item=>item!==win);
        // The panel loads its page on the first alert, which a busy build machine can take over a second to do, so this
        // waits for it to show, within the time an alert stays up.
        result.overlay=false;
        for(const until=Date.now()+6000;!result.overlay&&Date.now()<until;){
          await new Promise(resolve=>setTimeout(resolve,200));
          result.overlay=Boolean(panel&&panel.isVisible()&&!panel.isFocused()&&await panel.webContents.executeJavaScript(`!document.getElementById('alert').hidden&&document.getElementById('title').textContent==='Task finished · Smoke'`));
        }
        overlay.hide();
      }
      // Point and tell (#19): a local page opens in the preview, and a click while picking reports the element, with its
      // screenshot, instead of reaching the page.
      {
        const server=http.createServer((_request,response)=>{response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<!doctype html><title>Smoke app</title><main style="padding:40px"><button id="buy" onclick="document.title=\'clicked\'">Buy now</button></main>');});
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        try{
          const picked=new Promise(resolve=>previewPicks.push(resolve));
          await preview.open({projectId:null,url:`http://127.0.0.1:${server.address().port}/`,workspace:'Smoke'});
          preview.setPicking(true);
          const contents=preview.page.webContents,point=await contents.executeJavaScript(`(()=>{const r=document.getElementById('buy').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
          // As for a person, the click comes once the picker outlines the button under the pointer.
          let outlined=false;
          for(let step=0,until=Date.now()+5000;!outlined&&Date.now()<until;step++){
            contents.sendInputEvent({type:'mouseMove',x:point.x+step%2,y:point.y});
            await new Promise(resolve=>setTimeout(resolve,100));
            outlined=await contents.executeJavaScript(`document.querySelector('throughline-picker')?.style.display==='block'`);
          }
          contents.sendInputEvent({type:'mouseDown',x:point.x,y:point.y,button:'left',clickCount:1});
          contents.sendInputEvent({type:'mouseUp',x:point.x,y:point.y,button:'left',clickCount:1});
          const pick=await Promise.race([picked,new Promise(resolve=>setTimeout(()=>resolve(null),8000))]),title=await contents.executeJavaScript('document.title');
          result.preview=Boolean(outlined&&pick&&pick.element?.selector==='#buy'&&pick.element.text==='Buy now'&&pick.image?.data?.length>100&&pick.text.includes('the “Buy now” button (#buy)')&&title==='Smoke app');
          // A failure says which step went wrong.
          if(!result.preview)result.previewSteps={outlined,picked:Boolean(pick),selector:pick?.element?.selector??null,image:pick?.image?.data?.length??0,title};
        }finally{preview.close();server.close();}
      }
      if(process.platform==='darwin'&&app.isPackaged)result.speech=await new Promise(resolve=>execFile(helperPath(),['--check'],{timeout:15000},(_error,stdout)=>resolve(/"type":"check"/.test(String(stdout)))));
      result.terminalUI=await win.webContents.executeJavaScript(`typeof window.relayTerminal?.toggle==='function'&&typeof window.Terminal==='function'&&typeof window.FitAddon?.FitAddon==='function'`);
      // The menu bar is Throughline's. The page reports its state to it, and an item's command reaches the page and comes back as a tick.
      const settled=async done=>{for(let tries=0;!done()&&tries<250;tries++)await new Promise(resolve=>setTimeout(resolve,20));return done();};
      const reported=await settled(()=>page!==null);
      Menu.getApplicationMenu().getMenuItemById('appearance-light').click();
      const ticked=await settled(()=>nativeTheme.themeSource==='light'&&Menu.getApplicationMenu().getMenuItemById('appearance-light').checked);
      result.menu={labels:Menu.getApplicationMenu().items.map(item=>item.label),reported,ticked,theme:await win.webContents.executeJavaScript(`document.documentElement.getAttribute('data-theme')`)};
      // The setup header lies under the window-drag strip; each of its controls must still be what a click at its center reaches.
      result.setupHeader=await win.webContents.executeJavaScript(`window.relaySetup.open().then(()=>{const controls=[...document.querySelectorAll('.onboarding-header :is(button,a)')];return controls.length>0&&controls.every(control=>{const box=control.getBoundingClientRect();return control.contains(document.elementFromPoint(box.left+box.width/2,box.top+box.height/2));});})`);
      await win.webContents.executeJavaScript(`document.getElementById('setup-dialog').close()`);
      Menu.getApplicationMenu().getMenuItemById('whats-new').click();
      for(let tries=0;tries<100;tries++){result.updates=await win.webContents.executeJavaScript(`({open:document.getElementById('updates-dialog').open,notes:!!document.querySelector('#updates-content .updates-release')})`);if(result.updates.open)break;await new Promise(resolve=>setTimeout(resolve,20));}
      await win.webContents.executeJavaScript(`document.getElementById('updates-dismiss').click()`);
      for(let tries=0;tries<100;tries++){if(await win.webContents.executeJavaScript(`!document.getElementById('updates-dialog').open`)){result.updates.dismissed=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
      if(!result.isolated||!result.bridge||!result.launchBridge||!result.updateBridge||!result.terminal||!result.terminalUI||!result.voiceUI||result.speech===false||result.statusItem===false||result.overlay===false||!result.preview||!result.keepAwakeBridge||!result.usagePopover||!result.ui||!result.configuration||!result.models||!result.modelPicker||!result.permissions||!result.geminiImports||!result.git||!result.imports||!result.setupHeader||!result.review||!result.local||!result.updates.open||!result.updates.notes||!result.updates.dismissed||!['File','Edit','View','Agent','Workspace','Window','Help'].every(label=>result.menu.labels.includes(label))||!result.menu.reported||!result.menu.ticked||result.menu.theme!=='light')throw Error('Desktop smoke check failed: '+JSON.stringify(result));
      console.log('AI_RELAY_DESKTOP_SMOKE '+JSON.stringify(result));app.quit();
    }
  }).catch(error=>{console.error(error);if(!smoke)dialog.showErrorBox('Throughline could not start',error.message);app.exit(1);});
}
