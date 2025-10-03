const axios = require('axios');

// Test webhook URL - update this to your actual server URL
const WEBHOOK_URL = 'http://localhost:3000/api/webhook-retell';

// Test data for meetingBooked: true (should do nothing)
const testMeetingBookedTrue = {
  event: 'call_analyzed',
  call: {
    call_id: 'test_call_123',
    call_type: 'web_call',
    agent_id: 'agent_69d43809de75b3453192cc281e',
    agent_version: 0,
    agent_name: 'Prostruct',
    collected_dynamic_variables: {
      previous_node: 'Check Availability',
      current_node: 'Conversation',
      userNeed: '0',
      project_type: 'OSE (Structural)',
      userRoleValue: 'Homeowner',
      Location: '123 Test Street, San Francisco, CA 94032',
      description: 'Test user wants a structural inspection',
      name: 'Test User',
      email: 'test@example.com',
      meetingBooked: true // Meeting was booked successfully
    },
    call_status: 'ended',
    start_timestamp: Date.now() - 300000, // 5 minutes ago
    end_timestamp: Date.now(),
    duration_ms: 300000,
    transcript: 'Agent: Hi! how can I help you today?\nUser: I need structural inspection.\nAgent: Great! Let me book that for you.',
    recording_url: 'https://example.com/recording.wav',
    call_analysis: {
      call_summary: 'User successfully booked a structural inspection appointment.',
      in_voicemail: false,
      user_sentiment: 'Positive',
      call_successful: true,
      custom_analysis_data: {}
    }
  }
};

// Test data for meetingBooked: false (should send SMS and create contact/deal)
const testMeetingBookedFalse = {
  event: 'call_analyzed',
  call: {
    call_id: 'test_call_456',
    call_type: 'web_call',
    agent_id: 'agent_69d43809de75b3453192cc281e',
    agent_version: 0,
    agent_name: 'Prostruct',
    collected_dynamic_variables: {
      previous_node: 'Check Availability',
      current_node: 'Conversation',
      userNeed: '0',
      project_type: 'OSE (Structural)',
      userRoleValue: 'Homeowner',
      Location: '456 Test Avenue, San Francisco, CA 94032',
      description: 'Test user needs structural inspection but call disconnected',
      name: 'Test User 2',
      email: 'test2@example.com',
      meetingBooked: false // Meeting was NOT booked
    },
    call_status: 'ended',
    start_timestamp: Date.now() - 180000, // 3 minutes ago
    end_timestamp: Date.now(),
    duration_ms: 180000,
    transcript: 'Agent: Hi! how can I help you today?\nUser: I need structural inspection.\nAgent: Let me check availability... [call disconnected]',
    recording_url: 'https://example.com/recording2.wav',
    call_analysis: {
      call_summary: 'User called for structural inspection but call disconnected before booking.',
      in_voicemail: false,
      user_sentiment: 'Neutral',
      call_successful: false,
      custom_analysis_data: {}
    }
  }
};

// Test data with missing data (should handle gracefully)
const testMissingData = {
  event: 'call_analyzed',
  call: {
    call_id: 'test_call_789',
    call_type: 'web_call',
    agent_id: 'agent_69d43809de75b3453192cc281e',
    agent_version: 0,
    agent_name: 'Prostruct',
    collected_dynamic_variables: {
      previous_node: 'Greeting',
      current_node: 'Conversation',
      meetingBooked: false // Only meetingBooked is available
      // Missing: name, email, location, etc.
    },
    call_status: 'ended',
    start_timestamp: Date.now() - 60000, // 1 minute ago
    end_timestamp: Date.now(),
    duration_ms: 60000,
    transcript: 'Agent: Hi! how can I help you today?\nUser: Hello? [call disconnected]',
    recording_url: 'https://example.com/recording3.wav',
    call_analysis: {
      call_summary: 'Very short call, user disconnected quickly.',
      in_voicemail: false,
      user_sentiment: 'Neutral',
      call_successful: false,
      custom_analysis_data: {}
    }
  }
};

async function testWebhook(testName, testData) {
  console.log(`\n🧪 Testing: ${testName}`);
  console.log('📤 Sending webhook data:', JSON.stringify(testData, null, 2));
  
  try {
    const response = await axios.post(WEBHOOK_URL, testData, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 30000 // 30 second timeout
    });
    
    console.log('✅ Success! Response:', response.data);
    return true;
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
    return false;
  }
}

async function runTests() {
  console.log('🚀 Starting Webhook Tests...');
  console.log(`📍 Testing webhook at: ${WEBHOOK_URL}`);
  
  const results = [];
  
  // Test 1: Meeting booked (should do nothing)
  results.push(await testWebhook('Meeting Booked (should do nothing)', testMeetingBookedTrue));
  
  // Test 2: Meeting not booked (should send SMS and create contact/deal)
  results.push(await testWebhook('Meeting Not Booked (should send SMS and create contact/deal)', testMeetingBookedFalse));
  
  // Test 3: Missing data (should handle gracefully)
  results.push(await testWebhook('Missing Data (should handle gracefully)', testMissingData));
  
  // Summary
  console.log('\n📊 Test Results Summary:');
  console.log(`✅ Passed: ${results.filter(r => r).length}/${results.length}`);
  console.log(`❌ Failed: ${results.filter(r => !r).length}/${results.length}`);
  
  if (results.every(r => r)) {
    console.log('\n🎉 All tests passed!');
  } else {
    console.log('\n⚠️  Some tests failed. Check the logs above.');
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  runTests().catch(console.error);
}

module.exports = { testWebhook, runTests };
