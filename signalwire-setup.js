#!/usr/bin/env node

/**
 * SignalWire Account Setup Script
 * Configures phone numbers, webhooks, and application settings via API
 */

require('dotenv').config();
const axios = require('axios');

// SignalWire Configuration
const SIGNALWIRE_PROJECT_ID = process.env.SIGNALWIRE_PROJECT_ID;
const SIGNALWIRE_AUTH_TOKEN = process.env.SIGNALWIRE_AUTH_TOKEN;
const SIGNALWIRE_SPACE_URL = process.env.SIGNALWIRE_SPACE_URL;
const BASE_URL = process.env.BASE_URL || 'https://podcast-ivr-production.up.railway.app';

// Validate credentials
if (!SIGNALWIRE_PROJECT_ID || !SIGNALWIRE_AUTH_TOKEN || !SIGNALWIRE_SPACE_URL) {
  console.error('❌ Missing SignalWire credentials in .env file');
  console.error('Required: SIGNALWIRE_PROJECT_ID, SIGNALWIRE_AUTH_TOKEN, SIGNALWIRE_SPACE_URL');
  process.exit(1);
}

// Create SignalWire API client
const signalwireAPI = axios.create({
  baseURL: `https://${SIGNALWIRE_SPACE_URL}/api/relay/rest`,
  auth: {
    username: SIGNALWIRE_PROJECT_ID,
    password: SIGNALWIRE_AUTH_TOKEN
  },
  headers: {
    'Content-Type': 'application/json'
  }
});

// SignalWire REST API for account management
const signalwireREST = axios.create({
  baseURL: `https://${SIGNALWIRE_SPACE_URL}/api/laml/2010-04-01/Accounts/${SIGNALWIRE_PROJECT_ID}`,
  auth: {
    username: SIGNALWIRE_PROJECT_ID,
    password: SIGNALWIRE_AUTH_TOKEN
  },
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded'
  }
});

async function setupSignalWire() {
  console.log('🚀 Starting SignalWire Account Setup...\n');
  
  try {
    // Step 1: Verify account access
    console.log('1️⃣ Verifying SignalWire account access...');
    const accountInfo = await signalwireREST.get('');
    console.log(`✅ Account verified: ${accountInfo.data.friendly_name}`);
    console.log(`   Status: ${accountInfo.data.status}`);
    console.log(`   Type: ${accountInfo.data.type}\n`);

    // Step 2: List available phone numbers
    console.log('2️⃣ Checking available phone numbers...');
    const phoneNumbers = await signalwireREST.get('/IncomingPhoneNumbers');
    
    if (phoneNumbers.data.phone_numbers && phoneNumbers.data.phone_numbers.length > 0) {
      console.log(`✅ Found ${phoneNumbers.data.phone_numbers.length} phone number(s):`);
      phoneNumbers.data.phone_numbers.forEach((number, index) => {
        console.log(`   ${index + 1}. ${number.phone_number} (${number.friendly_name || 'No name'})`);
      });
      console.log();
      
      // Step 3: Configure the first phone number for IVR
      const firstNumber = phoneNumbers.data.phone_numbers[0];
      console.log(`3️⃣ Configuring phone number ${firstNumber.phone_number} for IVR...`);
      
      const webhookURL = `${BASE_URL}/webhook/ivr-main`;
      const statusCallbackURL = `${BASE_URL}/webhook/status`;
      
      const updateData = new URLSearchParams({
        VoiceUrl: webhookURL,
        VoiceMethod: 'POST',
        StatusCallback: statusCallbackURL,
        StatusCallbackMethod: 'POST',
        VoiceFallbackUrl: `${BASE_URL}/webhook/fallback`,
        VoiceFallbackMethod: 'POST'
      });
      
      const updateResponse = await signalwireREST.post(
        `/IncomingPhoneNumbers/${firstNumber.sid}`,
        updateData
      );
      
      console.log(`✅ Phone number configured successfully!`);
      console.log(`   Voice URL: ${webhookURL}`);
      console.log(`   Status Callback: ${statusCallbackURL}`);
      console.log(`   Fallback URL: ${BASE_URL}/webhook/fallback\n`);
      
    } else {
      console.log('⚠️ No phone numbers found. You need to purchase a phone number first.');
      console.log('   Visit your SignalWire dashboard to buy a number.\n');
    }

    // Step 4: Create application for better organization (optional)
    console.log('4️⃣ Creating SignalWire application for IVR...');
    try {
      const appData = new URLSearchParams({
        FriendlyName: 'Podcast IVR System',
        VoiceUrl: `${BASE_URL}/webhook/ivr-main`,
        VoiceMethod: 'POST',
        StatusCallback: `${BASE_URL}/webhook/status`,
        StatusCallbackMethod: 'POST',
        VoiceFallbackUrl: `${BASE_URL}/webhook/fallback`,
        VoiceFallbackMethod: 'POST'
      });
      
      const appResponse = await signalwireREST.post('/Applications', appData);
      console.log(`✅ Application created: ${appResponse.data.friendly_name}`);
      console.log(`   Application SID: ${appResponse.data.sid}\n`);
    } catch (appError) {
      console.log('ℹ️ Application creation skipped (may already exist)\n');
    }

    // Step 5: Test webhook connectivity
    console.log('5️⃣ Testing webhook connectivity...');
    try {
      const testResponse = await axios.get(`${BASE_URL}/`);
      console.log(`✅ Webhook server responding: ${testResponse.data.status}`);
      console.log(`   Voice Provider: ${testResponse.data.voiceProvider || 'Unknown'}`);
      console.log(`   Podcasts Available: ${testResponse.data.podcasts || 0}\n`);
    } catch (webhookError) {
      console.log(`⚠️ Warning: Could not reach webhook server at ${BASE_URL}`);
      console.log(`   Make sure your server is deployed and accessible\n`);
    }

    // Step 6: Display summary
    console.log('🎉 SignalWire Setup Complete!\n');
    console.log('📊 Configuration Summary:');
    console.log(`   Project ID: ${SIGNALWIRE_PROJECT_ID}`);
    console.log(`   Space URL: https://${SIGNALWIRE_SPACE_URL}`);
    console.log(`   Webhook Base: ${BASE_URL}`);
    console.log(`   Voice Endpoint: ${BASE_URL}/webhook/ivr-main`);
    
    if (phoneNumbers.data.phone_numbers && phoneNumbers.data.phone_numbers.length > 0) {
      console.log(`   Phone Number: ${phoneNumbers.data.phone_numbers[0].phone_number}`);
      console.log('\n✅ Your podcast IVR system is ready to receive calls!');
    } else {
      console.log('\n⚠️ Next step: Purchase a phone number in your SignalWire dashboard');
    }

  } catch (error) {
    console.error('❌ Setup failed:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Error:', error.response.data);
    }
    process.exit(1);
  }
}

// Additional utility functions
async function listPhoneNumbers() {
  console.log('📞 Available Phone Numbers:\n');
  try {
    const response = await signalwireREST.get('/IncomingPhoneNumbers');
    if (response.data.phone_numbers && response.data.phone_numbers.length > 0) {
      response.data.phone_numbers.forEach((number, index) => {
        console.log(`${index + 1}. ${number.phone_number}`);
        console.log(`   Name: ${number.friendly_name || 'No name'}`);
        console.log(`   Voice URL: ${number.voice_url || 'Not set'}`);
        console.log(`   SID: ${number.sid}`);
        console.log();
      });
    } else {
      console.log('No phone numbers found.');
    }
  } catch (error) {
    console.error('Failed to list phone numbers:', error.message);
  }
}

async function purchasePhoneNumber(areaCode = '844') {
  console.log(`🛒 Searching for available numbers in area code ${areaCode}...`);
  try {
    // Search for available numbers
    const searchResponse = await signalwireREST.get(`/AvailablePhoneNumbers/US/TollFree`);
    if (searchResponse.data.available_phone_numbers && searchResponse.data.available_phone_numbers.length > 0) {
      const number = searchResponse.data.available_phone_numbers[0];
      console.log(`Found number: ${number.phone_number}`);
      
      // Purchase the number
      const purchaseData = new URLSearchParams({
        PhoneNumber: number.phone_number,
        FriendlyName: 'Podcast IVR Line',
        VoiceUrl: `${BASE_URL}/webhook/ivr-main`,
        VoiceMethod: 'POST'
      });
      
      const purchaseResponse = await signalwireREST.post('/IncomingPhoneNumbers', purchaseData);
      console.log(`✅ Successfully purchased: ${purchaseResponse.data.phone_number}`);
      return purchaseResponse.data.phone_number;
    } else {
      console.log('No available numbers found.');
      return null;
    }
  } catch (error) {
    console.error('Failed to purchase phone number:', error.message);
    return null;
  }
}

// CLI interface
const command = process.argv[2];

switch (command) {
  case 'setup':
    setupSignalWire();
    break;
  case 'list-numbers':
    listPhoneNumbers();
    break;
  case 'buy-number':
    const areaCode = process.argv[3] || '844';
    purchasePhoneNumber(areaCode);
    break;
  default:
    console.log('SignalWire Setup Tool');
    console.log('');
    console.log('Usage:');
    console.log('  node signalwire-setup.js setup          # Full account setup');
    console.log('  node signalwire-setup.js list-numbers   # List phone numbers');
    console.log('  node signalwire-setup.js buy-number [area] # Purchase phone number');
    console.log('');
    console.log('Examples:');
    console.log('  node signalwire-setup.js setup');
    console.log('  node signalwire-setup.js buy-number 844');
}