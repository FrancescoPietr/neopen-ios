// @ts-nocheck -- codice upstream non compatibile con "strict"
var debug = true;
function log(...arg: any) {
  if (debug) console.log(...arg);
}

function setDebug(bool: boolean) {
  debug = bool;
}

export { log, debug, setDebug };
