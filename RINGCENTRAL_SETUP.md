# 📞 RingCentral Setup Instructions

## 🎯 **Option 1: Direct Webhook (Fastest)**

1. **Login to RingCentral Admin:**
   - Go to `admin.ringcentral.com`
   - Login with your account

2. **Configure Phone Number:**
   - Navigate to **Phone System → Phone Numbers**
   - Find your number `(904) 371-2672`
   - Click **Edit** → **Call Handling**
   - Set **"During Business Hours"** to: **"Forward to External Number"**
   - Enter: `https://podcast-ivr-production.up.railway.app/webhook/ivr-main`

---

## 🎛️ **Option 2: Auto-Receptionist (Recommended)**

### **Step 1: Create Auto-Receptionist**
1. **Phone System → Auto-Receptionist → Create New**
2. **Name:** `Podcast Hotline`
3. **Greeting:** Select **"Text-to-Speech"**
4. **Greeting Text:** 
   ```
   Welcome to the Podcast Hotline! Press 1 for Daily Tech News, 
   Press 2 for Weather and Traffic, Press 3 for Daily Stories, 
   Press 9 to repeat this menu, or Press 0 for a representative.
   ```

### **Step 2: Configure Key Mappings**
- **Press 1:** Transfer to Extension `101` (Tech News)
- **Press 2:** Transfer to Extension `102` (Weather)  
- **Press 3:** Transfer to Extension `103` (Stories)
- **Press 9:** Repeat Menu
- **Press 0:** Transfer to Operator (Extension `101`)

### **Step 3: Set Business Hours**
- **All Days:** `00:00` to `23:59` (24/7 operation)

### **Step 4: Assign Phone Number**
- **Phone System → Phone Numbers**
- Find `(904) 371-2672`
- Set **"Answered By"** to your new **"Podcast Hotline"** auto-receptionist

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