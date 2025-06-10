#!/usr/bin/env node

/**
 * Configure specific phone number for SignalWire webhook
 */

require('dotenv').config();
const axios = require('axios');

const SIGNALWIRE_PROJECT_ID = process.env.SIGNALWIRE_PROJECT_ID;
const SIGNALWIRE_AUTH_TOKEN = process.env.SIGNALWIRE_AUTH_TOKEN;
const SIGNALWIRE_SPACE_URL = process.env.SIGNALWIRE_SPACE_URL;
const PHONE_NUMBER = '+17276322781';
const BASE_URL = process.env.BASE_URL || 'https://podcast-ivr-production.up.railway.app';

if (!SIGNALWIRE_PROJECT_ID || !SIGNALWIRE_AUTH_TOKEN || !SIGNALWIRE_SPACE_URL) {
  console.error('❌ Missing SignalWire credentials');
  process.exit(1);
}

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

async function configurePhone() {
  console.log(`🔧 Configuring phone number ${PHONE_NUMBER}...\n`);
  
  try {
    // First, list all phone numbers to find the SID
    console.log('1️⃣ Finding phone number SID...');
    const phoneNumbers = await signalwireREST.get('/IncomingPhoneNumbers');
    
    console.log('📞 All phone numbers in account:');
    if (phoneNumbers.data.incoming_phone_numbers) {
      phoneNumbers.data.incoming_phone_numbers.forEach((number, index) => {
        console.log(`   ${index + 1}. ${number.phone_number} (SID: ${number.sid})`);
        console.log(`      Current Voice URL: ${number.voice_url || 'Not set'}`);
      });
    }
    
    // Find our specific number
    const targetNumber = phoneNumbers.data.incoming_phone_numbers?.find(
      num => num.phone_number === PHONE_NUMBER || num.phone_number === PHONE_NUMBER.replace('+1', '')
    );
    
    if (!targetNumber) {
      console.error(`❌ Phone number ${PHONE_NUMBER} not found in account`);
      console.log('Available numbers:');
      phoneNumbers.data.incoming_phone_numbers?.forEach(num => {
        console.log(`   ${num.phone_number}`);
      });
      return;
    }
    
    console.log(`✅ Found number: ${targetNumber.phone_number} (SID: ${targetNumber.sid})\n`);
    
    // Configure the webhook
    console.log('2️⃣ Configuring webhook URLs...');
    const webhookURL = `${BASE_URL}/webhook/ivr-main`;
    const statusCallbackURL = `${BASE_URL}/webhook/status`;
    const fallbackURL = `${BASE_URL}/webhook/fallback`;
    
    const updateData = new URLSearchParams({
      VoiceUrl: webhookURL,
      VoiceMethod: 'POST',
      StatusCallback: statusCallbackURL,
      StatusCallbackMethod: 'POST',
      VoiceFallbackUrl: fallbackURL,
      VoiceFallbackMethod: 'POST',
      FriendlyName: 'Podcast IVR Line'
    });
    
    const updateResponse = await signalwireREST.post(
      `/IncomingPhoneNumbers/${targetNumber.sid}`,
      updateData
    );
    
    console.log(`✅ Phone number configured successfully!`);
    console.log(`📞 Number: ${updateResponse.data.phone_number}`);
    console.log(`🔗 Voice URL: ${updateResponse.data.voice_url}`);
    console.log(`📊 Status Callback: ${updateResponse.data.status_callback}`);
    console.log(`🚨 Fallback URL: ${updateResponse.data.voice_fallback_url}\n`);
    
    // Test the webhook
    console.log('3️⃣ Testing webhook connectivity...');
    try {
      const testResponse = await axios.get(`${BASE_URL}/`);
      console.log(`✅ Server responding: ${testResponse.data.status}`);
      console.log(`📡 Voice Provider: ${testResponse.data.voiceProvider}`);
      console.log(`🎧 Podcasts Available: ${testResponse.data.podcasts}\n`);
      
      if (testResponse.data.voiceProvider === 'signalwire') {
        console.log('🎉 SignalWire integration is ACTIVE!');
      } else {
        console.log('⚠️ Warning: Server is not using SignalWire yet');
        console.log('   Make sure environment variables are set in Railway');
      }
    } catch (webhookError) {
      console.log(`❌ Warning: Could not reach webhook server at ${BASE_URL}`);
    }
    
    console.log('\n🔥 Setup Complete!');
    console.log(`📞 Call ${PHONE_NUMBER} to test your podcast IVR system!`);
    
  } catch (error) {
    console.error('❌ Configuration failed:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Details:', error.response.data);
    }
  }
}

configurePhone();