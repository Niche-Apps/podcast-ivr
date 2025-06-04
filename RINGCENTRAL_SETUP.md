# 📞 RingCentral Setup Instructions

## 🎯 **EASIEST METHOD: Manual Auto-Receptionist (5 minutes)**

**Skip the XML files - just create the IVR manually in RingCentral Admin:**

1. **Login to RingCentral Admin:**
   - Go to `admin.ringcentral.com`
   - Login with your account

2. **Create Auto-Receptionist:**
   - Navigate to **Phone System → Auto-Receptionist**
   - Click **"Create Auto-Receptionist"**
   - **Name:** `Podcast Hotline`
   - **Company Greeting:** Select **"Record or upload audio"** OR **"Use text-to-speech"**
   - **Greeting Text:** 
     ```
     Welcome to the Podcast Hotline! Press 1 for Daily Tech News, 
     Press 2 for Weather and Traffic, Press 3 for Daily Stories, 
     Press 9 to repeat this menu, or Press 0 for a representative.
     ```

3. **Configure Menu Options:**
   - **Press 1:** Send caller to → Extension → `101`
   - **Press 2:** Send caller to → Extension → `102`  
   - **Press 3:** Send caller to → Extension → `103`
   - **Press 9:** Repeat company greeting
   - **Press 0:** Send caller to → Extension → `101` (operator)

4. **Set Business Hours:** 24/7 (all days, all hours)

5. **Assign Phone Number:**
   - **Phone System → Phone Numbers**
   - Find `(904) 371-2672`
   - **"Answered by"** → Select your **"Podcast Hotline"** auto-receptionist
   - **Save**

---

## 🎯 **Alternative: Direct Webhook (Advanced)**

1. **Configure Phone Number:**
   - Navigate to **Phone System → Phone Numbers**
   - Find your number `(904) 371-2672`
   - Click **Edit** → **Call Handling**
   - Set **"During Business Hours"** to: **"Forward to External Number"**
   - Enter: `https://podcast-ivr-production.up.railway.app/webhook/ivr-main`

---

## 🎧 **Step 5: Configure Extensions for Podcast Audio**

### **Extension 101 - Daily Tech News**
1. **Users & Extensions → Extension 101**
2. **Call Handling → Business Hours**
3. **Set to:** "Take Messages Only"
4. **Custom Greeting:** Upload tech news audio or use TTS:
   ```
   You selected Daily Tech News. This episode is brought to you by TechCorp Solutions. 
   Here are today's top technology stories...
   ```

### **Extension 102 - Weather & Traffic**
1. **Users & Extensions → Extension 102**
2. **Call Handling → Business Hours**
3. **Set to:** "Take Messages Only"
4. **Custom Greeting:** Upload weather audio or use TTS:
   ```
   You selected Weather and Traffic. This update is sponsored by Dallas Auto Group. 
   Currently, it's 72 degrees and partly cloudy...
   ```

### **Extension 103 - Daily Stories**
1. **Users & Extensions → Extension 103**
2. **Call Handling → Business Hours**
3. **Set to:** "Take Messages Only"
4. **Custom Greeting:** Upload story audio or use TTS:
   ```
   You selected Daily Stories. Today's story is presented by StoryBrand Publishing. 
   Welcome to today's tale...
   ```

---

## 🚀 **Testing Your Setup**

1. **Call:** `(904) 371-2672`
2. **You should hear:** Welcome message with menu options
3. **Press 1, 2, or 3:** Should play respective podcast content
4. **Press 9:** Should repeat the menu
5. **Press 0:** Should transfer to operator

---

## 🔧 **Troubleshooting**

**If calls don't work:**
1. Check phone number assignment in RingCentral Admin
2. Verify auto-receptionist is enabled and saved
3. Ensure extensions 101, 102, 103 exist and are configured
4. Test webhook endpoints:
   - https://podcast-ivr-production.up.railway.app
   - https://podcast-ivr-production.up.railway.app/webhook/ivr-main

**For webhook tracking:**
- All calls are logged at: https://podcast-ivr-production.up.railway.app/analytics
- New episodes can be added via: https://podcast-ivr-production.up.railway.app/api/episodes/add

---

## 📊 **Your System Features**

✅ **24/7 Podcast Hotline:** (904) 371-2672  
✅ **3 Podcast Channels:** Tech News, Weather, Stories  
✅ **British TTS Voice:** Google Cloud Neural voice  
✅ **Call Tracking:** Revenue analytics for sponsors  
✅ **Dynamic Content:** API-driven episode management  
✅ **Railway Hosted:** Scalable cloud deployment  

**🎉 Your podcast IVR system is ready to go live!**