import * as lark from '@larksuiteoapi/node-sdk';

console.log('=== Testing Feishu SDK ===');
console.log('Available exports:', Object.keys(lark));

// 检查 WSClient
console.log('\nWSClient:', typeof lark.WSClient);
console.log('WsClient:', typeof lark.WsClient);

// 检查 Client
console.log('\nClient:', typeof lark.Client);

// 检查 AppType 和 Domain
console.log('\nAppType:', typeof lark.AppType, lark.AppType ? Object.keys(lark.AppType) : 'N/A');
console.log('Domain:', typeof lark.Domain, lark.Domain ? Object.keys(lark.Domain) : 'N/A');
