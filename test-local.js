// Simple local test script to test webhook without making HTTP requests
const { webhookRetell } = require('./src/controllers/meetingController');

// Mock request and response objects
function createMockReqRes(testData) {
  const req = {
    body: testData
  };
  
  const res = {
    json: (data) => {
      console.log('📤 Response:', data);
      return res;
    },
    status: (code) => {
      console.log('📊 Status Code:', code);
      return res;
    }
  };
  
  return { req, res };
}

// Test data for meetingBooked: true
const testMeetingBookedTrue = {
  event: 'call_analyzed',
  call: {
    call_id: 'test_call_123',
    call_type: 'web_call',
    agent_id: 'agent_69d43809de75b3453192cc281e',
    agent_name: 'Prostruct',
    collected_dynamic_variables: {
      name: 'Test User',
      email: 'test@example.com',
      Location: '123 Test Street, San Francisco, CA',
      userRoleValue: 'Homeowner',
      project_type: 'OSE (Structural)',
      description: 'Test structural inspection',
      meetingBooked: true
    },
    call_analysis: {
      call_summary: 'User successfully booked appointment'
    },
    recording_url: 'https://example.com/recording.wav'
  }
};

// Test data for meetingBooked: false
const testMeetingBookedFalse = {
  event: 'call_analyzed',
  call: {
    call_id: 'test_call_456',
    call_type: 'web_call',
    agent_id: 'agent_69d43809de75b3453192cc281e',
    agent_name: 'Prostruct',
    collected_dynamic_variables: {
      name: 'Test User 2',
      email: 'test2@example.com',
      Location: '456 Test Avenue, San Francisco, CA',
      userRoleValue: 'Homeowner',
      project_type: 'OSE (Structural)',
      description: 'Test structural inspection - call disconnected',
      meetingBooked: false
    },
    call_analysis: {
      call_summary: 'User called but call disconnected before booking'
    },
    recording_url: 'https://example.com/recording2.wav'
  }
};

// Test data with missing information
const testMissingData = {
  event: 'call_analyzed',
  call: {
    call_id: 'test_call_789',
    call_type: 'web_call',
    agent_id: 'agent_69d43809de75b3453192cc281e',
    agent_name: 'Prostruct',
    collected_dynamic_variables: {
      meetingBooked: false
      // Missing: name, email, location, etc.
    },
    call_analysis: {
      call_summary: 'Very short call, minimal data collected'
    },
    recording_url: 'https://example.com/recording3.wav'
  }
};

async function runLocalTests() {
  console.log('🧪 Running Local Webhook Tests...\n');
  
  // Test 1: Meeting booked (should do nothing)
  console.log('Test 1: Meeting Booked (should do nothing)');
  console.log('='.repeat(50));
  const { req: req1, res: res1 } = createMockReqRes(testMeetingBookedTrue);
  await webhookRetell(req1, res1);
  
  console.log('\n');
  
  // Test 2: Meeting not booked (should send SMS and create contact/deal)
  console.log('Test 2: Meeting Not Booked (should send SMS and create contact/deal)');
  console.log('='.repeat(50));
  const { req: req2, res: res2 } = createMockReqRes(testMeetingBookedFalse);
  await webhookRetell(req2, res2);
  
  console.log('\n');
  
  // Test 3: Missing data (should handle gracefully)
  console.log('Test 3: Missing Data (should handle gracefully)');
  console.log('='.repeat(50));
  const { req: req3, res: res3 } = createMockReqRes(testMissingData);
  await webhookRetell(req3, res3);
  
  console.log('\n✅ Local tests completed!');
}

// Run tests
runLocalTests().catch(console.error);
