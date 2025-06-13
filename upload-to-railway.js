#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Set Railway token from .env
const RAILWAY_TOKEN = '775a3b1e-37dd-46cf-aa93-46b8c2eb8ab6';
const PROJECT_ID = '388935f6-4305-4087-be51-95ab9f14b59c';

// Local debates folder
const debatesPath = path.join(__dirname, 'public', 'debates');

console.log('🚂 Railway MP3 Upload Script');
console.log('============================');

// Check if debates folder exists
if (!fs.existsSync(debatesPath)) {
    console.error('❌ Debates folder not found:', debatesPath);
    process.exit(1);
}

// Get MP3 files
const files = fs.readdirSync(debatesPath);
const mp3Files = files.filter(file => file.toLowerCase().endsWith('.mp3'));

console.log(`📁 Found ${mp3Files.length} MP3 files in ${debatesPath}`);

if (mp3Files.length === 0) {
    console.log('⚠️  No MP3 files found to upload');
    process.exit(0);
}

// Set environment variable and try Railway shell command
try {
    console.log('🔑 Setting Railway token...');
    process.env.RAILWAY_TOKEN = RAILWAY_TOKEN;
    
    console.log('📂 Creating debates directory on Railway...');
    execSync(`railway shell "mkdir -p public/debates"`, { 
        stdio: 'inherit',
        env: { ...process.env, RAILWAY_TOKEN: RAILWAY_TOKEN }
    });
    
    console.log('📤 Uploading MP3 files...');
    mp3Files.forEach((file, index) => {
        console.log(`   ${index + 1}/${mp3Files.length}: ${file}`);
        try {
            execSync(`railway shell "cat > public/debates/${file}" < "${path.join(debatesPath, file)}"`, {
                stdio: 'inherit',
                env: { ...process.env, RAILWAY_TOKEN: RAILWAY_TOKEN }
            });
        } catch (error) {
            console.error(`   ❌ Failed to upload ${file}:`, error.message);
        }
    });
    
    console.log('✅ Upload complete!');
    console.log('🔗 Test at: https://podcast-ivr-production.up.railway.app/debates-list');
    
} catch (error) {
    console.error('❌ Railway upload failed:', error.message);
    console.log('\n💡 Alternative: Try manual Railway dashboard upload:');
    console.log('   1. Go to https://railway.app/project/' + PROJECT_ID);
    console.log('   2. Navigate to Files tab');
    console.log('   3. Upload MP3 files to public/debates/ folder');
}