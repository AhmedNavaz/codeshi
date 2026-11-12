import {app,BaseWindow,BrowserWindow,Menu,Notification,Tray,WebContentsView,contentTracing,dialog,ipcMain,nativeImage,nativeTheme,screen,session,shell,powerSaveBlocker} from 'electron';
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
import {runningEdit,statusSnapshot,statusTitle,statusMenu,statusTooltip,statusClickTarget,taskbarIsLight} from './status.mjs';
import {alertPlan,alertSample,pillSample,progressPillOn} from '../src/alerts.mjs';
import {english} from '../src/i18n.mjs';
import {createOverlay} from './overlay.mjs';
import {giveFrontBack} from './front.mjs';
import {closeWithin,writeShutdownLog} from './shutdown.mjs';
import {commandState,connectionFile,installCommand,removeConnection,uninstallCommand,writeConnection} from './cli.mjs';
import {createPreview} from './preview.mjs';
import {createTraceRecorder} from './trace.mjs';
import {APP_ID,ensureStartMenuShortcut} from './windows.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const smoke=process.argv.includes('--smoke-test');
// Started by the codeshi command (#90) with no window: the engine and the menu bar status only. A window opens when asked
// for (the command's /open, the status menu, or opening Codeshi again), and an untouched background start quits by itself
// once no terminal is attached and nothing is working.
const background=!smoke&&process.argv.includes('--background');
let windowWanted=!background,pageLoaded=false,openMain=null;
// A copy run from source is a separate app from the installed one: its own name, data folder and single-instance
// lock. Both run side by side in their own windows, and testing from source never opens or changes the installed
// app's workspaces and conversations.
const development=!app.isPackaged;
// `npm run start:update-demo`: from source only, an update is offered and installed without downloading or replacing anything.
const updateDemo=development&&process.argv.includes('--update-demo');
if(development)app.setName('Codeshi Dev');
if(process.env.AI_RELAY_DESKTOP_DATA) app.setPath('userData',path.resolve(process.env.AI_RELAY_DESKTOP_DATA));
// A development profile from before the rename keeps its workspaces.
else if(development) app.setPath('userData',preferredUserData(app.getPath('appData'),path.join(app.getPath('appData'),'Codeshi Dev'),['Throughline Dev']));
else app.setPath('userData',preferredUserData(app.getPath('appData'),app.getPath('userData')));
// Windows ties notifications and the taskbar entry to this ID (see windows.mjs).
if(process.platform==='win32'&&!development)app.setAppUserModelId(APP_ID);
const primary=app.requestSingleInstanceLock();
let relay,win,origin,keepAwake,updater,tray=null,overlay=null,preview=null,quitting=false;
// The words of the menus and the status item, in the interface language (#27).
let text=english;
if(!primary) app.quit();
else {
  app.on('second-instance',(_event,argv=[])=>{if(argv.includes('--background'))return;if(openMain)return openMain();windowWanted=true;app.dock?.show();if(win){if(win.isMinimized())win.restore();win.show();win.focus();}});
  app.on('before-quit',event=>{if(relay&&!quitting){event.preventDefault();quitting=true;if(win&&!win.isDestroyed())win.webContents.send('relay:quitting');keepAwake?.dispose();updater?.finishOnQuit();updater?.dispose();closeWithin(options=>relay.close(options),{log:line=>writeShutdownLog(path.join(app.getPath('userData'),'shutdown.log'),line)}).then(()=>{app.quit();setTimeout(()=>app.exit(0),2000);});}});
  app.on('will-quit',()=>{removeConnection(connectionFile(app.getPath('userData')));keepAwake?.dispose();overlay?.dispose();preview?.dispose();tray?.destroy();tray=null;});
  app.on('window-all-closed',()=>app.quit());
  app.whenReady().then(async()=>{
    // The packaged app's layered icon switches between Paper and Ink with the appearance; in development the Dock shows a picture, so swap it.
    if(process.platform==='darwin'&&!app.isPackaged){const dockIcon=()=>app.dock?.setIcon(path.join(root,'assets',nativeTheme.shouldUseDarkColors?'icon-dark.png':'icon.png'));dockIcon();nativeTheme.on('updated',dockIcon);}
    if(process.platform==='win32'&&!development&&!smoke){try{ensureStartMenuShortcut({shell,programs:path.join(app.getPath('appData'),'Microsoft','Windows','Start Menu','Programs'),target:process.execPath});}catch(error){console.warn('Windows notifications need a Start menu shortcut:',error.message);}}
    const data=path.join(app.getPath('userData'),'relay-data');
    migrateLegacyData(process.env.AI_RELAY_LEGACY_DATA_DIR || path.join(root,'.data'),data);
    const releases=createReleaseState({filename:path.join(app.getPath('userData'),'install.json'),version:app.getVersion(),changelog:fs.readFileSync(path.join(root,'CHANGELOG.md'),'utf8'),existing:['projects.json','settings.json'].some(name=>fs.existsSync(path.join(data,name)))});
    const token=randomBytes(32).toString('hex');
    const appearance=createAppearance({nativeTheme,onBackground:color=>{if(win&&!win.isDestroyed())win.setBackgroundColor(color);}});
    // The menu bar shows what the page last reported, the saved appearance and Keep Awake.
    let page=null,awake=false;
    // Help › Record Performance Trace: ten seconds of tracing for every Codeshi process, kept on this computer (trace.mjs).
    const tracer=createTraceRecorder({tracing:contentTracing,metrics:()=>app.getAppMetrics(),directory:path.join(app.getPath('userData'),'performance-traces'),onChange:()=>updateMenu()});
    const recordTrace=async()=>{
      const {t}=text,owner=win&&!win.isDestroyed()?win:undefined;
      try{
        const {file,summary}=await tracer.record(),{cpu}=summary;
        const answer=await dialog.showMessageBox(owner,{type:'info',message:t('Performance trace saved'),
          detail:t('Over {seconds} seconds, Codeshi used this much of one CPU core: pages {pages}%, graphics {graphics}%, the app itself {app}%, other helpers {other}%. The trace stays on this computer. It holds timings, script names and request addresses, not chat text.',{seconds:summary.seconds,pages:cpu.pages,graphics:cpu.graphics,app:cpu.app,other:cpu.other}),
          buttons:[process.platform==='darwin'?t('Show in Finder'):t('Show in Folder'),t('OK')],defaultId:1,cancelId:1});
        if(answer.response===0)shell.showItemInFolder(file);
      }catch(error){dialog.showErrorBox(t('The performance trace was not saved'),error?.message||String(error));}
    };
    // Codeshi › Install 'codeshi' Command (#90): a link to bin/codeshi in this app, which runs the CLI with the app's own Node.
    const commandTarget=path.join(root,'bin','codeshi');
    const command=async install=>{
      const {t}=text,owner=win&&!win.isDestroyed()?win:undefined;
      try{
        const result=install?await installCommand({target:commandTarget}):await uninstallCommand({target:commandTarget});
        if(result.cancelled)return;
        await dialog.showMessageBox(owner,{type:'info',message:install?t('The codeshi command is installed'):t('The codeshi command is removed'),
          detail:install?t('In a terminal, run codeshi in a project folder to work with your agents there. codeshi --help lists the commands for scripts. If Codeshi isn’t open, it starts in the background.'):t('Install it again from the Codeshi menu at any time.'),buttons:[t('OK')]});
      }catch(error){dialog.showErrorBox(install?t('The codeshi command was not installed'):t('The codeshi command was not removed'),error?.message||String(error));}
      updateMenu();
    };
    const updateMenu=()=>Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate({platform:process.platform,packaged:app.isPackaged,updates:Boolean(updater?.state().supported),version:app.getVersion(),osVersion:process.getSystemVersion(),arch:process.arch,text,state:page,appearance:relay.getAppearancePreference(),keepAwake:awake,notifications:relay.getNotificationPreferences(),setNotifications:patch=>{relay.setNotificationPreferences(patch);updateMenu();syncStatus();},handoff:relay.getHandoffPreferences(),setHandoff:patch=>{relay.setHandoffPreferences(patch);updateMenu();},open:url=>shell.openExternal(url),tracing:tracer.isRecording(),recordTrace,command:process.platform==="darwin"?{state:commandState({target:commandTarget}),install:()=>command(true),uninstall:()=>command(false)}:null,
      // A clicked checkbox or radio item ticks itself, so the menu is rebuilt to show the page's answer instead.
      send:(...command)=>{if(win&&!win.isDestroyed())win.webContents.send('relay:menu-command',...command);updateMenu();}})));
    app.setAboutPanelOptions({applicationName:'Codeshi',applicationVersion:app.getVersion(),version:''});
    // Work that finishes or needs an answer while the person is elsewhere is reported outside the window, in the ways
    // chosen under Alerts (src/alerts.mjs). While the window is in front the page already shows it. The Dock badge
    // counts what happened since the window was last in front and needs no permission; something that needs you
    // bounces the Dock until the app is opened. A system notification is shown where macOS allows one: an app without
    // a Developer ID signature is refused. On Windows and Linux the taskbar button flashes instead of the Dock bouncing.
    let attention=0,notificationsRefused=false;
    // Brings the window forward, opening a workspace or an approval's request card. Nothing is answered on the way.
    function openTarget(target){
      if(!win||win.isDestroyed())return;
      windowWanted=true;app.dock?.show();
      // A background start loads the page only now, so nothing renders while no one looks.
      if(!pageLoaded){loadPage().then(()=>openTarget(target),()=>{});return;}
      if(win.isMinimized())win.restore();win.show();win.focus();app.focus?.({steal:true});
      if(target?.projectId)win.webContents.send('relay:menu-command',target.approvalId?'open-approval':'open-workspace',target.approvalId?{projectId:target.projectId,approvalId:target.approvalId}:target.projectId);
    }
    // A banner is the panel near the top of the screen when that is chosen (#13), or else a system notification, so
    // nothing is announced twice. Each way is skipped when it is turned off for this moment.
    function notify({kind,title,body,projectId,projectName,approvalId}){
      const plan=alertPlan({kind},relay.getNotificationPreferences(),{focused:Boolean(win&&!win.isDestroyed()&&win.isFocused()),panelAvailable:Boolean(overlay)});
      if(plan.badge&&app.dock){attention++;app.dock.setBadge(String(attention));}
      if(plan.bounce){app.dock?.bounce(plan.moment==='attention'?'critical':'informational');if(process.platform!=='darwin'&&win&&!win.isDestroyed())win.flashFrame(true);}
      if(plan.panel){overlay.show({kind,title,body,projectId,projectName,approvalId});return;}
      if(!plan.notification||notificationsRefused||!Notification.isSupported())return;
      // Banners are silent: the page plays alert sounds itself, as chosen in Settings, so a sound is never heard twice.
      const notice=new Notification({title:projectName?`${title} · ${projectName}`:title,body:String(body||'').slice(0,240),silent:true});
      // An approval opens its own request card; it is never answered from the notification.
      notice.on('click',()=>openTarget(projectId?{projectId,approvalId:kind==='approval'?approvalId:null}:null));
      notice.on('failed',(_event,error)=>{notificationsRefused=true;console.warn('macOS did not show a Codeshi notification:',error);});
      notice.show();
    }
    // macOS colours its template images itself. Windows has none (#74), so its icons come drawn for a dark and for a light taskbar.
    const statusIcon=name=>nativeImage.createFromPath(path.join(root,'assets','status',name)),windows=process.platform==='win32';
    const statusIcons=process.platform==='darwin'?{idle:statusIcon('StatusTemplate.png'),attention:statusIcon('StatusAttentionTemplate.png')}
      :windows?{idle:statusIcon('TrayDark.ico'),attention:statusIcon('TrayDarkAttention.ico'),lightIdle:statusIcon('TrayLight.ico'),lightAttention:statusIcon('TrayLightAttention.ico')}:null;
    // The taskbar's colour is a Windows setting apart from the apps' and from Codeshi's own theme, so it is read from the registry.
    let statusTimer=null,lightTaskbar=false,statusSeen={rows:[],attention:0,running:0};
    function readTaskbar(){if(!windows)return;execFile('reg',['query','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize','/v','SystemUsesLightTheme'],{timeout:5000,windowsHide:true},(_error,stdout)=>{const light=taskbarIsLight(stdout);if(light!==lightTaskbar){lightTaskbar=light;scheduleStatus();}});}
    function scheduleStatus(){if(!statusTimer)statusTimer=setTimeout(syncStatus,400);}
    function setStatusPreferences(patch){relay.setNotificationPreferences(patch);updateMenu();syncStatus();}
    function syncStatus(){
      clearTimeout(statusTimer);statusTimer=null;
      if(!statusIcons||!relay||quitting)return;
      const preferences=relay.getNotificationPreferences(),progress=Boolean(overlay)&&progressPillOn(preferences);
      // The panel near the top of the screen follows the same status, including when the menu bar item is hidden:
      // its progress pill (#75) and an approval's alert, which goes once the approval is answered.
      if(!preferences.statusItem){tray?.destroy();tray=null;if(!progress&&!overlay?.current&&!overlay?.pill)return;}
      const snapshot=statusSeen=statusSnapshot(relay.registry,text);
      overlay?.progress(snapshot,{enabled:progress,text});overlay?.reconcile(snapshot);
      if(!preferences.statusItem)return;
      if(!tray){
        if(windows){
          // A left click brings Codeshi forward, to the one thing that needs you when there is exactly one; a right click opens the menu.
          tray=new Tray(statusIcons.idle);tray.on('click',()=>openTarget(statusClickTarget(statusSeen)));
        }else{for(const icon of Object.values(statusIcons))icon.setTemplateImage(true);tray=new Tray(statusIcons.idle);tray.setToolTip('Codeshi');}
      }
      if(windows){
        // Windows shows no words beside the icon: the dot says something needs you, and the tooltip says what.
        tray.setImage(lightTaskbar?snapshot.attention?statusIcons.lightAttention:statusIcons.lightIdle:snapshot.attention?statusIcons.attention:statusIcons.idle);
        tray.setToolTip(statusTooltip(snapshot,text));
      }else{
        // With a Codeshi window in front the window says it all, so the item is the plain mark with no words.
        const focused=Boolean(BrowserWindow.getFocusedWindow());
        tray.setImage(snapshot.attention&&!focused?statusIcons.attention:statusIcons.idle);
        tray.setTitle(statusTitle(snapshot,text,{focused}),{fontType:'monospacedDigit'});
      }
      tray.setContextMenu(Menu.buildFromTemplate(statusMenu(snapshot,{platform:process.platform,text,keepAwake:keepAwake?.getState()||{enabled:false,active:false},alerts:preferences,setAlerts:setStatusPreferences,alertSettings:()=>{openTarget(null);win?.webContents.send('relay:menu-command','alert-settings');},open:openTarget,show:()=>openTarget(null),setKeepAwake:value=>keepAwake?.setEnabled(value),hide:()=>setStatusPreferences({statusItem:false}),quit:()=>app.quit()})));
    }
    async function start(){
      relay=createRelayServer({dataRoot:data,accessToken:token,onAppearance:preference=>{appearance.set(preference);updateMenu();},onHandoff:()=>updateMenu(),onNotify:notify,onNotifications:()=>{updateMenu();scheduleStatus();},
        // The page reloads itself in a newly chosen language; the menus and the status item follow here.
        systemLanguages:()=>app.getPreferredSystemLanguages?.()||[app.getLocale()],onLanguage:()=>{text=relay.getText();updateMenu();scheduleStatus();},
        onOpenWindow:target=>openTarget(target?.projectId?target:null),
        // The codeshi tab in the window (#90) runs the command inside this app against this engine.
        cliConnection:smoke?null:connectionFile(app.getPath('userData'))});
      text=relay.getText();
      appearance.set(relay.getAppearancePreference());
      keepAwake=createKeepAwake({registry:relay.registry,blocker:powerSaveBlocker,enabled:relay.getKeepAwakePreference(),save:relay.setKeepAwakePreference,onChange:state=>{awake=state.enabled;if(win&&!win.isDestroyed())win.webContents.send('relay:keep-awake-changed',state);updateMenu();scheduleStatus();}});
      await new Promise((resolve,reject)=>{relay.server.once('error',reject);relay.server.listen(0,'127.0.0.1',resolve);});
      origin=`http://127.0.0.1:${relay.server.address().port}`;
      // The codeshi command (#90) finds this engine through cli.json; the smoke test leaves it alone.
      if(!smoke){try{writeConnection(connectionFile(app.getPath('userData')),{url:origin,token,version:app.getVersion()});}catch(error){console.warn('The codeshi command cannot reach Codeshi:',error.message);}}
    }
    await start();
    // Codeshi restarts to update only when no agent is working and no queued prompt is about to start.
    const busy=()=>[...relay.registry.brokers.values()].some(({broker})=>broker.running||broker.backgroundReview||broker.tasks?.busy||[...broker.conversations.values()].some(c=>c.queue?.length&&!c.queuePaused));
    const build=updateBuild({arch:process.arch,translated:app.runningUnderARM64Translation}),demo=updateDemo?(await import('./update-demo.mjs')).updateDemo({version:app.getVersion(),build,relaunch:()=>{app.relaunch();app.quit();}}):null;
    updater=createUpdater({version:app.getVersion(),build,location:demo?.location||bundleLocation(process.execPath),directory:path.join(app.getPath('userData'),demo?'updates-demo':'updates'),supported:Boolean(demo)||app.isPackaged&&!smoke,...(demo?{fetchImpl:demo.fetchImpl,exec:demo.exec,launch:demo.launch}:{}),busy,quit:demo?.quit||(()=>app.quit()),onState:state=>{if(win&&!win.isDestroyed())win.webContents.send('relay:update-state',state);}});
    if(demo)updater.check();
    relay.registry.on('update',()=>setTimeout(()=>updater.idle(),0));
    // Live status on the Mac (#13): the menu bar item follows every workspace's runs, approvals and waits.
    // In the Windows notification area (#74) an icon does the same, with the words in its tooltip.
    // The progress pill shows only while no Codeshi window is in front; focus moving between its windows passes through none.
    if(process.platform==='darwin'){
      overlay=createOverlay({BrowserWindow,screen,ipcMain,root,open:openTarget,isFocused:()=>Boolean(BrowserWindow.getFocusedWindow()),yieldFront:()=>{giveFrontBack().catch(()=>{});}});
      // The menu bar status drops its words at once when a window comes forward, and gets them back after focus has settled.
      app.on('browser-window-focus',()=>{overlay?.refresh();syncStatus();});app.on('browser-window-blur',()=>setTimeout(()=>{overlay?.refresh();syncStatus();},150));
    }
    if(statusIcons){relay.registry.on('update',scheduleStatus);relay.registry.on('projects',scheduleStatus);}
    if(windows){readTaskbar();nativeTheme.on('updated',readTaskbar);}
    updateMenu();syncStatus();
    function loadPage(){pageLoaded=true;return win.loadURL(origin);}
    win=new BrowserWindow({width:1440,height:1000,minWidth:900,minHeight:680,show:false,title:'Codeshi',icon:path.join(root,'assets','icon.png'),backgroundColor:appearance.background(),...(process.platform==='darwin'?{titleBarStyle:'hiddenInset',trafficLightPosition:{x:14,y:13}}:{}),webPreferences:{preload:path.join(root,'desktop','preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,additionalArguments:[...(development?['--relay-channel=development']:[]),`--relay-token=${token}`]}});
    // Back in the window, the page shows what happened, including the recap after a while away, so the badge clears
    // and the panel near the top of the screen goes; it would otherwise cover the recap.
    win.on('focus',()=>{attention=0;app.dock?.setBadge('');overlay?.hide();if(process.platform!=='darwin')win.flashFrame(false);readTaskbar();});
    // The window list and the app switcher tell the two copies apart.
    if(development)win.on('page-title-updated',(event,title)=>{event.preventDefault();win.setTitle(`${title} (Development)`);});
    if(!smoke) win.once('ready-to-show',()=>{if(windowWanted)win.show();});
    if(background&&!windowWanted){
      app.dock?.hide();
      // Two quiet minutes in a row: no window wanted, no terminal following, nothing working or queued.
      let quiet=0;
      const idleQuit=setInterval(()=>{
        if(windowWanted){clearInterval(idleQuit);return;}
        quiet=busy()||relay.eventClients()>0?0:quiet+1;
        if(quiet>=2){clearInterval(idleQuit);app.quit();}
      },60000);
      idleQuit.unref?.();
      // Opening Codeshi from the Finder or Spotlight while it runs in the background shows the window.
      app.on('activate',()=>{if(!windowWanted)openTarget(null);});
    }
    const trusted=event=>event.sender===win.webContents && event.senderFrame===win.webContents.mainFrame && event.senderFrame.url.startsWith(origin+'/');
    ipcMain.handle('relay:keep-awake:get',event=>{if(!trusted(event))throw Error('Untrusted renderer');return keepAwake.getState();});
    ipcMain.handle('relay:keep-awake:set',(event,enabled)=>{if(!trusted(event))throw Error('Untrusted renderer');return keepAwake.setEnabled(enabled);});
    ipcMain.handle('relay:launch',event=>{if(!trusted(event))throw Error('Untrusted renderer');return releases.get();});
    ipcMain.handle('relay:acknowledge-update',event=>{if(!trusted(event))throw Error('Untrusted renderer');return releases.acknowledge();});
    ipcMain.handle('relay:update:get',event=>{if(!trusted(event))throw Error('Untrusted renderer');return updater.state();});
    ipcMain.handle('relay:update:check',event=>{if(!trusted(event))throw Error('Untrusted renderer');return updater.check();});
    ipcMain.handle('relay:update:install',event=>{if(!trusted(event))throw Error('Untrusted renderer');return updater.install();});
    ipcMain.handle('relay:update:restart',event=>{if(!trusted(event))throw Error('Untrusted renderer');return updater.restart();});
    ipcMain.handle('relay:update:cancel',event=>{if(!trusted(event))throw Error('Untrusted renderer');return updater.cancel();});
    ipcMain.handle('relay:update:skip',(event,version)=>{if(!trusted(event))throw Error('Untrusted renderer');return updater.skip(version);});
    ipcMain.handle('relay:update:automatic',(event,enabled)=>{if(!trusted(event))throw Error('Untrusted renderer');return updater.setAutomatic(enabled);});
    // Try it in Settings › Alerts: the real banner or panel, Dock badge and bounce for one moment, as chosen, with a
    // made-up example (src/alerts.mjs); the page plays the sound. It says what showed, and whether macOS refused the
    // banner. The Dock bounces only while another app is in front, so the bounce waits a few seconds for you to leave.
    let tryBadge=null,tryBounce=null;
    ipcMain.handle('relay:alert:try',async(event,input)=>{
      if(!trusted(event))throw Error('Untrusted renderer');
      const sample=alertSample(input?.moment,relay.getNotificationPreferences(),{panelAvailable:Boolean(overlay),t:text.t});
      if(!sample)throw Error('Unknown alert moment');
      const {plan,kind,title,body}=sample,result={panel:false,banner:null,badge:false,bounce:null};
      if(plan.panel){overlay.show({kind,title,body});result.panel=true;}
      else if(plan.notification){
        if(!Notification.isSupported())result.banner='refused';
        else result.banner=await new Promise(resolve=>{const notice=new Notification({title,body,silent:true});const timer=setTimeout(()=>resolve(notificationsRefused?'refused':'sent'),1500);notice.on('show',()=>{clearTimeout(timer);resolve('shown');});notice.on('failed',()=>{clearTimeout(timer);notificationsRefused=true;resolve('refused');});notice.on('click',()=>openTarget(null));notice.show();});
      }
      if(plan.badge&&app.dock){clearTimeout(tryBadge);app.dock.setBadge(String(attention+1));result.badge=true;tryBadge=setTimeout(()=>app.dock?.setBadge(attention?String(attention):''),6000);}
      if(plan.bounce&&win&&!win.isDestroyed()){
        const bounce=()=>{if(process.platform==='darwin')app.dock?.bounce('informational');else if(!win.isDestroyed())win.flashFrame(true);};
        tryBounce?.();
        if(!win.isFocused()){bounce();result.bounce='now';}
        else{const timer=setTimeout(()=>tryBounce?.(),8000),onBlur=()=>{tryBounce?.();bounce();};win.once('blur',onBlur);tryBounce=()=>{clearTimeout(timer);win.off('blur',onBlur);tryBounce=null;};result.bounce='when-away';}
      }
      return result;
    });
    // Show the pill: the pill under the menu bar with an example line, for a few seconds, even with Codeshi in front.
    ipcMain.handle('relay:pill:try',event=>{if(!trusted(event))throw Error('Untrusted renderer');if(!overlay)return false;overlay.show(pillSample(text.t));return true;});
    ipcMain.on('relay:menu-state',(event,input)=>{if(!trusted(event))return;const next=menuState(input);if(next){page=next;updateMenu();}});
    // Point and tell (#19): the workspace's app in a preview window, one for each interface opened (#142); an element
    // picked in any of them goes to the message box of that window's workspace.
    const previewPicks=[];
    preview=createPreview({BaseWindow,WebContentsView,session,ipcMain,shell,screen,root,background:()=>appearance.background(),
      folders:id=>{try{return id?relay.registry.get(id).folders.map(folder=>({name:folder.displayName||folder.name,path:folder.path})):[];}catch{return [];}},
      onPick:pick=>{for(const resolve of previewPicks.splice(0))resolve(pick);if(!win||win.isDestroyed())return;if(pick.focus){if(win.isMinimized())win.restore();win.show();win.focus();win.webContents.send('relay:menu-command','focus-message');return;}win.webContents.send('relay:preview-pick',{projectId:pick.projectId,text:pick.text,image:pick.image,...(pick.design?{design:true,images:pick.images}:{})});}});
    const previewStack=id=>{
      try{
        const review=relay.projectReview?.state(id);
        const run=review?.run,plan=review?.plan;
        const profile=plan?.profiles?.find(p=>p.id===(run?.profileId||"development"))||plan?.profiles?.[0];
        if(!profile&&!run)return null;
        return {
          profile:run?.profileName||profile?.name||"",
          prerequisites:profile?.prerequisites||[],
          services:(run?.steps||profile?.services||[]).map(s=>({
            id:s.id,name:s.name,kind:s.kind,status:s.status||"waiting",ready:s.ready,
            url:s.ready?.url||(s.ready?.port?`http://127.0.0.1:${s.ready.port}`:null),
            folder:s.folderName,command:s.command,
          })),
          previews:run?.previews||profile?.previews||(profile?.preview?[profile.preview]:[]),
        };
      }catch{return null;}
    };
    const syncPreviewStack=id=>{if(preview?.shows(id))preview.showStack(id,previewStack(id));};
    // The preview toolbars follow the edits in the workspace they show (#102).
    relay.registry.on('update',({projectId})=>{if(preview?.shows(projectId)){preview.showEdit(projectId,runningEdit(relay.registry,projectId));syncPreviewStack(projectId);}});
    // The stack comes first, so a new window is named after its interface from the start.
    ipcMain.handle('relay:preview:open',async(event,input)=>{if(!trusted(event))throw Error('Untrusted renderer');const project=relay.registry.get(String(input?.projectId||''));preview.showStack(project.id,previewStack(project.id));return preview.open({projectId:project.id,url:input?.url,workspace:project.name});});
    // Stop review closes the workspace's windows showing the review's services; the person's other windows stay.
    ipcMain.handle('relay:preview:close',(event,input)=>{if(!trusted(event))throw Error('Untrusted renderer');const urls=Array.isArray(input?.urls)?input.urls.slice(0,24).map(String):[];return preview.close({projectId:String(input?.projectId||''),urls});});
    // Several folders can be chosen at once; the page adds every one of them.
    ipcMain.handle('relay:pick-folder',async event=>{if(!trusted(event))throw Error('Untrusted renderer');const choice=await dialog.showOpenDialog(win,{properties:['openDirectory','multiSelections'],message:'Choose one or more project folders. Hold ⌘ to select several.'});return choice.canceled||!choice.filePaths.length?null:choice.filePaths;});
    // A Codeshi backup (#160): where to save one, or which one to import. The page gets the path; the server reads and
    // writes the file.
    ipcMain.handle('relay:pick-backup',async(event,input)=>{if(!trusted(event))throw Error('Untrusted renderer');const filters=[{name:'Codeshi Backup',extensions:['codeshibackup']}];if(input?.mode==='save'){const name=String(input?.name||'Codeshi Backup.codeshibackup').replace(/[\\/:]/g,'-').slice(0,120);const choice=await dialog.showSaveDialog(win,{defaultPath:path.join(app.getPath('documents'),name),filters,properties:['createDirectory','showOverwriteConfirmation']});return choice.canceled||!choice.filePath?null:choice.filePath;}const choice=await dialog.showOpenDialog(win,{properties:['openFile'],filters});return choice.canceled||!choice.filePaths.length?null:choice.filePaths[0];});
    ipcMain.handle('relay:open-external',async(event,input)=>{if(!trusted(event))throw Error('Untrusted renderer');const url=new URL(input);if(url.username||url.password||(url.protocol!=='https:' && !(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw Error('Only HTTPS or local test links without credentials may open');await shell.openExternal(url.href);return true;});
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(origin+'/'))event.preventDefault();});
    // Only clipboard writes (Copy buttons) are granted; every other permission stays denied.
    win.webContents.session.setPermissionRequestHandler((_contents,permission,callback)=>callback(permission==='clipboard-sanitized-write'));
    openMain=()=>openTarget(null);
    if(windowWanted)await loadPage();
    if(smoke){
      const smokeStep=step=>console.log('AI_RELAY_SMOKE_STEP '+step);
      smokeStep('renderer');
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
      // On Windows the icon is in the notification area, with all four of its drawings loaded (#74).
      if(windows)result.statusItem=Boolean(tray&&!tray.isDestroyed()&&Object.values(statusIcons).every(icon=>!icon.isEmpty())&&statusMenu(statusSnapshot(relay.registry),{platform:'win32'}).length>0);
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
      smokeStep('preview');
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
            outlined=await contents.executeJavaScript(`document.querySelector('codeshi-picker')?.style.display==='block'`);
          }
          contents.sendInputEvent({type:'mouseDown',x:point.x,y:point.y,button:'left',clickCount:1});
          contents.sendInputEvent({type:'mouseUp',x:point.x,y:point.y,button:'left',clickCount:1});
          const pick=await Promise.race([picked,new Promise(resolve=>setTimeout(()=>resolve(null),8000))]),title=await contents.executeJavaScript('document.title');
          // The screenshot only helps a pick: the app leaves it out when the window hasn't painted or the capture hangs,
          // as on a CI machine's display. There a pick without one passes, and the check says why it is missing.
          const pictured=pick?.image?.data?.length>100,picture=pictured||(process.env.CI==='true'&&['blank','hung'].includes(preview.lastCapture));
          result.preview=Boolean(outlined&&pick&&pick.element?.selector==='#buy'&&pick.element.text==='Buy now'&&picture&&pick.text.includes('the “Buy now” button (#buy)')&&title==='Smoke app');
          if(!pictured)result.previewCapture=preview.lastCapture;
          // A failure says which step went wrong.
          if(!result.preview)result.previewSteps={outlined,picked:Boolean(pick),selector:pick?.element?.selector??null,image:pick?.image?.data?.length??0,capture:preview.lastCapture,title};
        }finally{preview.close();server.close();}
      }
      smokeStep('menus');
      await win.webContents.executeJavaScript(`document.documentElement.dataset.smokeTest = 'true'`);
      if(process.platform==='darwin'&&app.isPackaged)result.speech=await new Promise(resolve=>execFile(helperPath(),['--check'],{timeout:15000},(_error,stdout)=>resolve(/"type":"check"/.test(String(stdout)))));
      result.terminalUI=await win.webContents.executeJavaScript(`typeof window.relayTerminal?.toggle==='function'&&typeof window.Terminal==='function'&&typeof window.FitAddon?.FitAddon==='function'&&typeof window.WebLinksAddon?.WebLinksAddon==='function'`);
      // The menu bar is Codeshi's. The page reports its state to it, and an item's command reaches the page and comes back as a tick.
      const settled=async done=>{for(let tries=0;!done()&&tries<250;tries++)await new Promise(resolve=>setTimeout(resolve,20));return done();};
      const reported=await settled(()=>page!==null);
      Menu.getApplicationMenu().getMenuItemById('appearance-light').click();
      const ticked=await settled(()=>nativeTheme.themeSource==='light'&&Menu.getApplicationMenu().getMenuItemById('appearance-light').checked);
      result.menu={labels:Menu.getApplicationMenu().items.map(item=>item.label),reported,ticked,theme:await win.webContents.executeJavaScript(`document.documentElement.getAttribute('data-theme')`)};
      smokeStep('setup');
      // The setup header lies under the window-drag strip; each of its controls must still be what a click at its center reaches.
      result.setupHeader=await win.webContents.executeJavaScript(`window.relaySetup.open().then(()=>{const controls=[...document.querySelectorAll('.onboarding-header :is(button,a)')];return controls.length>0&&controls.every(control=>{const box=control.getBoundingClientRect();return control.contains(document.elementFromPoint(box.left+box.width/2,box.top+box.height/2));});})`);
      await win.webContents.executeJavaScript(`document.getElementById('setup-dialog').close()`);
      smokeStep('updates');
      Menu.getApplicationMenu().getMenuItemById('whats-new').click();
      for(let tries=0;tries<100;tries++){result.updates=await win.webContents.executeJavaScript(`({open:document.getElementById('updates-dialog').open,notes:!!document.querySelector('#updates-content .updates-release')})`);if(result.updates.open&&result.updates.notes)break;await new Promise(resolve=>setTimeout(resolve,20));}
      await win.webContents.executeJavaScript(`document.getElementById('updates-dismiss').click()`);
      for(let tries=0;tries<100;tries++){if(await win.webContents.executeJavaScript(`!document.getElementById('updates-dialog').open`)){result.updates.dismissed=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
      smokeStep('flow');
      // Flow: exercise the real renderer/API with a disposable workspace and no installed agents.
      {
        // Let native rendering advance, including on macOS with a hidden main window.
        win.showInactive();
        const folder=path.join(app.getPath('userData'),'flow-smoke-workspace');fs.mkdirSync(folder,{recursive:true});
        const project=relay.registry.add({path:folder,name:'Flow smoke'});
        await win.webContents.executeJavaScript(`(async()=>{await window.relayUI.refreshProjects({choose:true});await window.relayUI.selectProject(${JSON.stringify(project.id)});})()`);
        smokeStep('flow project');
        // The view refuses to change while the workspace is still loading, as it does for a person, so keep asking.
        // A first launch on a slow machine can stay busy for a while.
        for(let tries=0;tries<1500;tries++){if(await win.webContents.executeJavaScript(`window.relayFlow.isOn()?!window.relayFlow.isLocked():(window.relayFlow.isLocked()||window.relayFlow.enter(),false)`))break;await new Promise(resolve=>setTimeout(resolve,20));}
        // If it never entered, say what it was waiting for.
        const entry=await win.webContents.executeJavaScript(`(()=>{const s=window.relayUI.getState(),c=s.conversation;return {on:window.relayFlow.isOn(),locked:window.relayFlow.isLocked(),ready:s.ready,loading:s.loading,pending:s.pending,settingsPending:s.settingsPending,taskDraft:Boolean(s.taskDraft),activity:s.status?.workspaceActivity,running:s.status?.runningConversationId,status:c?.status,queue:c?.queue?.length,notice:document.querySelector('#notice,.notice')?.textContent||null};})()`);
        smokeStep('flow entered '+entry.on);
        // Routing is Flow's: entering turns it on, Smart by default, and leaving turns it off.
        for(let tries=0;tries<250;tries++){if(await win.webContents.executeJavaScript(`['smart','balanced'].includes(window.relayUI.getState().conversation?.routing?.mode)`))break;await new Promise(resolve=>setTimeout(resolve,20));}
        win.setContentSize(1440,900);
        result.flow=await win.webContents.executeJavaScript(`(async()=>{
          await new Promise(resolve=>requestAnimationFrame(resolve));
          const left=document.getElementById('flow-left');
          window.relayAgents.open();await new Promise(resolve=>setTimeout(resolve,20));
          const close=document.getElementById('flow-detail-close'),rect=close.getBoundingClientRect();
          const details=document.getElementById('flow-detail').open&&document.getElementById('agents-panel').parentElement.id==='flow-detail-body'&&close.contains(document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2));
          close.click();await new Promise(resolve=>setTimeout(resolve,20));
          // The header spans the window: the seal beside the window controls, search in the middle, the way out at the far right.
          const header=document.getElementById('conversation-header'),brand=document.getElementById('flow-brand').getBoundingClientRect(),search=document.querySelector('.command-bar').getBoundingClientRect(),out=document.getElementById('toggle-flow').getBoundingClientRect();
          const headerPlaced=header.parentElement.id==='app-shell'&&brand.top>=0&&brand.bottom<=56&&brand.left>=(document.documentElement.classList.contains('mac-titlebar')?82:0)&&Math.abs((search.left+search.right)/2-innerWidth/2)<8&&out.right>innerWidth-40&&out.right<=innerWidth;
          // Remote access opens in Flow's own sheet, drawn by the same module as the Settings section.
          document.getElementById('connect-phone').click();
          for(let tries=0;tries<250&&!document.querySelector('.flow-phone .settings-row');tries++)await new Promise(resolve=>setTimeout(resolve,20));
          const remote=document.getElementById('flow-detail').open&&document.getElementById('flow-detail-title').textContent==='Remote access'&&!document.getElementById('settings').open&&!!document.querySelector('.flow-phone .settings-row');
          // If the sheet didn't load, say what it showed.
          const remoteDebug=remote?null:{open:document.getElementById('flow-detail').open,title:document.getElementById('flow-detail-title').textContent,settings:document.getElementById('settings').open,shown:document.querySelector('.flow-phone')?.textContent?.slice(0,160)??null,hidden:document.hidden};
          close.click();await new Promise(resolve=>setTimeout(resolve,20));
          return {remoteDebug,entered:window.relayFlow.isOn(),footerHidden:getComputedStyle(document.querySelector('.status-bar')).display==='none',cards:window.relayFlow.cards().length===7&&document.querySelectorAll('.flow-card:not(.flow-lounge-card)').length===7,windowControlsClear:left.getBoundingClientRect().top>=56&&getComputedStyle(left).webkitAppRegion!=='drag',details:details&&!document.getElementById('flow-detail').open,headerPlaced,remote:remote&&!document.getElementById('flow-detail').open,noPreview:!document.querySelector('.flow-preview-badge')&&!document.getElementById('flow-about'),routingOn:['smart','balanced'].includes(window.relayUI.getState().conversation.routing?.mode)&&!document.querySelector('.routing-option[data-mode="manual"]')&&!document.getElementById('agents-routing').hidden};
        })()`);
        const screenshot=path.join(os.tmpdir(),`codeshi-flow-${process.pid}.png`);
        const captured=await Promise.race([win.webContents.capturePage(),new Promise(resolve=>setTimeout(()=>resolve(null),3000))]);
        if(captured&&!captured.isEmpty()){fs.writeFileSync(screenshot,captured.toPNG());result.flow.screenshot=screenshot;}else result.flow.screenshotUnavailable=true;
        win.setContentSize(900,800);
        await new Promise(resolve=>setTimeout(resolve,100));
        result.flow.narrow=await win.webContents.executeJavaScript(`document.getElementById('flow-left').hidden&&!document.getElementById('flow-strip').hidden&&document.querySelectorAll('.flow-chip').length===8`);
        const broker=relay.registry.broker(project.id),conversation=[...broker.conversations.values()][0];
        conversation.status='running';conversation.activeRun={id:'flow-smoke-run',provider:'codex',mode:'read',startedAt:new Date().toISOString(),phase:'working'};
        await win.webContents.executeJavaScript(`window.relayUI.refresh()`);
        result.flow.locked=await win.webContents.executeJavaScript(`document.getElementById('toggle-flow').disabled&&window.relayFlow.leave()===false&&window.relayFlow.isOn()`);
        conversation.status='idle';conversation.activeRun=null;
        await win.webContents.executeJavaScript(`window.relayUI.refresh().then(()=>window.relayFlow.leave())`);
        for(let tries=0;tries<250;tries++){if(await win.webContents.executeJavaScript(`!window.relayFlow.isOn()&&!window.relayFlow.isLocked()`))break;await new Promise(resolve=>setTimeout(resolve,20));}
        result.flow.left=await win.webContents.executeJavaScript(`!window.relayFlow.isOn()&&getComputedStyle(document.querySelector('.status-bar')).display!=='none'`);
        for(let tries=0;tries<250;tries++){if(await win.webContents.executeJavaScript(`!window.relayUI.getState().conversation?.routing`))break;await new Promise(resolve=>setTimeout(resolve,20));}
        result.flow.routingOff=await win.webContents.executeJavaScript(`!window.relayUI.getState().conversation?.routing&&document.getElementById('agents-routing').hidden`);
        result.flow.passed=['entered','footerHidden','cards','windowControlsClear','details','headerPlaced','remote','noPreview','routingOn','narrow','locked','left','routingOff'].every(key=>result.flow[key]===true);
        console.log('AI_RELAY_FLOW_SMOKE '+JSON.stringify(result.flow));
        if(!result.flow.passed)throw Error('Flow smoke check failed: '+JSON.stringify({...result.flow,entry}));
      }
      if(!result.isolated||!result.bridge||!result.launchBridge||!result.updateBridge||!result.terminal||!result.terminalUI||!result.voiceUI||result.speech===false||result.statusItem===false||result.overlay===false||!result.preview||!result.keepAwakeBridge||!result.usagePopover||!result.ui||!result.configuration||!result.models||!result.modelPicker||!result.permissions||!result.geminiImports||!result.git||!result.imports||!result.setupHeader||!result.review||!result.local||!result.updates.open||!result.updates.notes||!result.updates.dismissed||!['File','Edit','View','Agent','Workspace','Window','Help'].every(label=>result.menu.labels.includes(label))||!result.menu.reported||!result.menu.ticked||result.menu.theme!=='light')throw Error('Desktop smoke check failed: '+JSON.stringify(result));
      console.log('AI_RELAY_DESKTOP_SMOKE '+JSON.stringify(result));app.quit();
    }
  }).catch(error=>{console.error(error);if(!smoke)dialog.showErrorBox('Codeshi could not start',error.message);app.exit(1);});
}
