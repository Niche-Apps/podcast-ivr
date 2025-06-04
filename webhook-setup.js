require('dotenv').config();
const SDK = require('@ringcentral/sdk').SDK;

// RingCentral configuration
const rc = new SDK({
  server: process.env.RC_SERVER_URL,
  clientId: process.env.RC_CLIENT_ID,
  clientSecret: process.env.RC_CLIENT_SECRET
});

async function setupWebhook() {
  try {
    // Login
    await rc.login({ jwt: process.env.RC_JWT_TOKEN });
    console.log('✅ Authenticated with RingCentral');

    // Your webhook URL
    const webhookUrl = 'https://podcast-ivr-production.up.railway.app/webhook';

    // Create webhook subscription
    const subscription = await rc.post('/restapi/v1.0/subscription', {
      eventFilters: [
        '/restapi/v1.0/account/~/telephony/sessions',
        '/restapi/v1.0/account/~/extension/~/telephony/sessions'
      ],
      deliveryMode: {
        transportType: 'WebHook',
        address: webhookUrl
      },
      expiresIn: 630720000 // 20 years (maximum allowed)
    });

    const response = await subscription.json();
    
    console.log('🎉 Webhook created successfully!');
    console.log(`📋 Subscription ID: ${response.id}`);
    console.log(`🔗 Webhook URL: ${webhookUrl}`);
    console.log(`⏰ Expires: ${response.expirationTime}`);
    console.log(`📅 Status: ${response.status}`);
    
  } catch (error) {
    console.error('❌ Error setting up webhook:', error.message);
    if (error.response) {
      const errorDetails = await error.response.json();
      console.error('Error details:', errorDetails);
    }
  }
}

// Run the setup
setupWebhook();