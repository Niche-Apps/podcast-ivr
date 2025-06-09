#!/usr/bin/env node

// Voice Prompts Management Script
// Usage: node manage-prompts.js [command] [options]

const fs = require('fs');
const path = require('path');

const PROMPTS_FILE = path.join(__dirname, 'voice-prompts.json');

// Load prompts
function loadPrompts() {
  try {
    return JSON.parse(fs.readFileSync(PROMPTS_FILE, 'utf8'));
  } catch (error) {
    console.error('❌ Failed to load voice-prompts.json:', error.message);
    process.exit(1);
  }
}

// Save prompts
function savePrompts(prompts) {
  try {
    prompts.metadata.lastUpdated = new Date().toISOString().split('T')[0];
    fs.writeFileSync(PROMPTS_FILE, JSON.stringify(prompts, null, 2));
    console.log('✅ Voice prompts saved');
  } catch (error) {
    console.error('❌ Failed to save prompts:', error.message);
  }
}

// Commands
const commands = {
  list: (category) => {
    const prompts = loadPrompts();
    
    if (category) {
      if (!prompts[category]) {
        console.error(`❌ Category '${category}' not found`);
        return;
      }
      
      console.log(`\n🎙️ VOICE PROMPTS - ${category.toUpperCase()}:`);
      Object.entries(prompts[category]).forEach(([key, text]) => {
        if (typeof text === 'string') {
          console.log(`  ${key}: "${text}"`);
        }
      });
    } else {
      console.log('\n🎙️ ALL VOICE PROMPT CATEGORIES:');
      Object.keys(prompts).forEach(category => {
        if (category !== 'metadata' && category !== 'customization') {
          const count = Object.keys(prompts[category]).filter(k => typeof prompts[category][k] === 'string').length;
          console.log(`  ${category}: ${count} prompts`);
        }
      });
      
      console.log(`\n📊 Total: ${prompts.metadata.totalPrompts} prompts`);
      console.log(`📅 Last updated: ${prompts.metadata.lastUpdated}`);
    }
  },

  edit: (category, key, newText) => {
    if (!category || !key || !newText) {
      console.error('❌ Usage: node manage-prompts.js edit <category> <key> "new text"');
      return;
    }
    
    const prompts = loadPrompts();
    
    if (!prompts[category]) {
      console.error(`❌ Category '${category}' not found`);
      return;
    }
    
    if (!prompts[category][key]) {
      console.error(`❌ Prompt '${category}.${key}' not found`);
      return;
    }
    
    const oldText = prompts[category][key];
    prompts[category][key] = newText;
    
    savePrompts(prompts);
    console.log(`✅ Updated ${category}.${key}`);
    console.log(`   Old: "${oldText}"`);
    console.log(`   New: "${newText}"`);
  },

  add: (category, key, text) => {
    if (!category || !key || !text) {
      console.error('❌ Usage: node manage-prompts.js add <category> <key> "prompt text"');
      return;
    }
    
    const prompts = loadPrompts();
    
    if (!prompts[category]) {
      prompts[category] = {};
    }
    
    if (prompts[category][key]) {
      console.error(`❌ Prompt '${category}.${key}' already exists. Use 'edit' to modify.`);
      return;
    }
    
    prompts[category][key] = text;
    prompts.metadata.totalPrompts = (prompts.metadata.totalPrompts || 0) + 1;
    
    savePrompts(prompts);
    console.log(`✅ Added ${category}.${key}: "${text}"`);
  },

  find: (searchText) => {
    if (!searchText) {
      console.error('❌ Usage: node manage-prompts.js find "search text"');
      return;
    }
    
    const prompts = loadPrompts();
    const results = [];
    
    Object.entries(prompts).forEach(([category, categoryPrompts]) => {
      if (typeof categoryPrompts === 'object' && category !== 'metadata' && category !== 'customization') {
        Object.entries(categoryPrompts).forEach(([key, text]) => {
          if (typeof text === 'string' && text.toLowerCase().includes(searchText.toLowerCase())) {
            results.push({ category, key, text });
          }
        });
      }
    });
    
    if (results.length === 0) {
      console.log(`❌ No prompts found containing: "${searchText}"`);
    } else {
      console.log(`\n🔍 Found ${results.length} prompts containing: "${searchText}"`);
      results.forEach(result => {
        console.log(`  ${result.category}.${result.key}: "${result.text}"`);
      });
    }
  },

  validate: () => {
    const prompts = loadPrompts();
    let issues = 0;
    
    console.log('🔍 Validating voice prompts...');
    
    // Check for missing variables
    Object.entries(prompts).forEach(([category, categoryPrompts]) => {
      if (typeof categoryPrompts === 'object' && category !== 'metadata' && category !== 'customization') {
        Object.entries(categoryPrompts).forEach(([key, text]) => {
          if (typeof text === 'string') {
            // Check for unclosed variables
            const openBraces = (text.match(/\\{/g) || []).length;
            const closeBraces = (text.match(/\\}/g) || []).length;
            
            if (openBraces !== closeBraces) {
              console.log(`⚠️  ${category}.${key}: Mismatched braces in "${text}"`);
              issues++;
            }
            
            // Check for very long prompts (might be too long for voice)
            if (text.length > 300) {
              console.log(`⚠️  ${category}.${key}: Very long prompt (${text.length} chars)`);
              issues++;
            }
          }
        });
      }
    });
    
    if (issues === 0) {
      console.log('✅ All prompts validated successfully');
    } else {
      console.log(`❌ Found ${issues} potential issues`);
    }
  },

  deploy: () => {
    console.log('🚀 To deploy prompt changes to Railway:');
    console.log('1. git add voice-prompts.json');
    console.log('2. git commit -m "Update voice prompts"');
    console.log('3. git push origin main');
    console.log('4. Railway will auto-deploy the updated prompts');
  },

  help: () => {
    console.log(`
🎙️ Voice Prompts Management Tool

Commands:
  list [category]              - List all prompts or prompts in category
  edit <cat> <key> "text"     - Edit existing prompt
  add <cat> <key> "text"      - Add new prompt
  find "search text"          - Search prompts by content
  validate                    - Check prompts for issues
  deploy                      - Show deployment instructions
  help                        - Show this help

Categories: mainMenu, systemTest, weather, podcasts, errors, navigation, analytics

Examples:
  node manage-prompts.js list weather
  node manage-prompts.js edit weather introduction "Welcome to weather service"
  node manage-prompts.js find "zipcode"
  node manage-prompts.js validate
`);
  }
};

// Parse command line arguments
const [,, command, ...args] = process.argv;

if (!command || !commands[command]) {
  commands.help();
  process.exit(1);
}

// Execute command
commands[command](...args);