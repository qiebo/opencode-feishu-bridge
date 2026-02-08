import * as lark from '@larksuiteoapi/node-sdk';

console.log('=== Testing Feishu SDK Imports ===');
console.log('Available exports:', Object.keys(lark));

// 检查 WSClient
console.log('\nWSClient:', typeof lark.WSClient);

// 检查是否有 ws 相关模块
console.log('\nTrying to find WS module...');
console.log('lark.ws:', typeof lark.ws);
console.log('lark.WS:', typeof lark.WS);

// 检查 Client 是否有 ws 方法
const client = new lark.Client({
  appId: 'test',
  appSecret: 'test',
});
console.log('\nClient methods:', Object.keys(client).filter(k => k.toLowerCase().includes('ws') || k.toLowerCase().includes('socket')));
