#!/usr/bin/env node

const { exec } = require('child_process');
const path = require('path');

console.log('🚀 Webhook Testing Setup');
console.log('========================\n');

console.log('You have two options to test your webhook:\n');

console.log('1️⃣  LOCAL TEST (No server needed):');
console.log('   node test-local.js');
console.log('   - Tests the webhook function directly');
console.log('   - No HTTP requests');
console.log('   - Good for testing logic without external dependencies\n');

console.log('2️⃣  LIVE TEST (Server must be running):');
console.log('   node test-webhook.js');
console.log('   - Tests the webhook via HTTP requests');
console.log('   - Requires your server to be running on port 3000');
console.log('   - Tests the full webhook endpoint\n');

console.log('📋 Test Scenarios:');
console.log('   ✅ Meeting Booked (should do nothing)');
console.log('   ✅ Meeting Not Booked (should send SMS + create contact/deal)');
console.log('   ✅ Missing Data (should handle gracefully)\n');

console.log('🔧 To start your server:');
console.log('   npm run dev');
console.log('   or');
console.log('   npm start\n');

console.log('Choose your test method and run the command above! 🎯');
