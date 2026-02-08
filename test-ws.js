const { Client, WsClient } = require('@larksuiteoapi/node-sdk');

console.log('Client:', typeof Client);
console.log('WsClient:', typeof WsClient);

if (WsClient) {
  console.log('WsClient is available');
} else {
  console.log('WsClient is NOT available, checking Client...');
  console.log('Client methods:', Object.keys(Client.prototype || {}));
}
