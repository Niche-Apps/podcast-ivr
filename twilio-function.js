// Twilio Function to handle incoming calls and connect to Railway deployment
// This function should be deployed to Twilio Functions
// URL: https://your-account.twil.io/your-function-path

exports.handler = function(context, event, callback) {
    const twiml = new Twilio.twiml.VoiceResponse();
    
    // Your Railway deployment URL
    const railwayUrl = context.RAILWAY_URL || 'https://your-railway-deployment.railway.app';
    
    console.log('📞 Incoming call from:', event.From);
    console.log('📍 Redirecting to Railway deployment:', railwayUrl);
    
    // Redirect all incoming calls to your Railway-deployed server
    twiml.redirect(`${railwayUrl}/webhook/ivr-main`);
    
    callback(null, twiml);
};

// Alternative: Direct webhook handling in Twilio Function
// If you prefer to handle some logic directly in Twilio Functions:

exports.handleMenu = function(context, event, callback) {
    const twiml = new Twilio.twiml.VoiceResponse();
    const railwayUrl = context.RAILWAY_URL || 'https://your-railway-deployment.railway.app';
    
    // Main menu
    const gather = twiml.gather({
        numDigits: 1,
        timeout: 10,
        action: `${railwayUrl}/webhook/ivr-response`,
        method: 'POST'
    });
    
    gather.say({
        voice: 'alice',
        language: 'en-US'
    }, 'Welcome to the Podcast Hotline! Press 1 for NPR News Now, 2 for This American Life, 3 for The Daily, 4 for Serial, 5 for Matt Walsh Show, 6 for Ben Shapiro Show, 7 for Michael Knowles Show, 8 for Andrew Klavan Show, 9 for Pints with Aquinas, or 0 for Joe Rogan. For more options, press star. Please make your selection now.');
    
    twiml.say({
        voice: 'alice',
        language: 'en-US'
    }, 'We didn\'t receive your selection. Please call back and try again.');
    
    twiml.hangup();
    
    callback(null, twiml);
};

// Configuration for Environment Variables in Twilio Functions:
// RAILWAY_URL = https://your-railway-deployment.railway.app
// (Add this in your Twilio Function's Environment Variables section)