const { contextBridge, ipcRenderer } = require('electron');
const call = channel => input => ipcRenderer.invoke(channel, input);
const listen = channel => listener => { ipcRenderer.on(channel, (_event, payload) => listener(payload)); };

contextBridge.exposeInMainWorld('buddyLive', Object.freeze({
  start: call('live:start'),
  finish: call('live:finish'),
  pin: call('live:pin'),
  hideInShare: call('live:hide-in-share'),
  resize: call('live:resize'),
  answer: call('live:answer'),
  cancel: call('live:cancel'),
  close: call('live:close'),
  send: (source, frame) => ipcRenderer.send('live:pcm', source, frame),
  onTranscript: listen('live:transcript'),
  onWarning: listen('live:warning'),
  onDelta: listen('live:delta'),
}));
