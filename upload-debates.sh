#!/bin/bash

# Set Railway token and link to project
export RAILWAY_TOKEN=775a3b1e-37dd-46cf-aa93-46b8c2eb8ab6
railway link 388935f6-4305-4087-be51-95ab9f14b59c

cd public/debates

echo "Uploading debate files to Railway volume..."

echo "1/5: Uploading Jimmy Akin vs Bart Ehrman..."
cat "DEBATE--Jimmy-Akin-vs-Bart-Ehrman-|-Are-the-Gospels-Historically-Reliable?.mp3" | railway run "cat > public/debates/debate1.mp3"

echo "2/5: Uploading Jimmy Akin vs James White..."
cat "Jimmy-Akin-vs-James-White--Sola-Scriptura.mp3" | railway run "cat > public/debates/debate2.mp3"

echo "3/5: Uploading KJV Debate..."
cat "KJV-Debate--James-White-&-Thomas-Ross--King-James-Bible-Only-&-Textus-Receptus-Modern-Versions-&-LSB.mp3" | railway run "cat > public/debates/debate3.mp3"

echo "4/5: Uploading Walter Martin vs Ed Decker..."
cat "Walter-Martin-vs.-Ed-Decker-Dialogue-on-the-Doorstep-with-a-Mormon.mp3" | railway run "cat > public/debates/debate4.mp3"

echo "5/5: Uploading test debate..."
cat "test-debate.mp3" | railway run "cat > public/debates/test.mp3"

echo "Done! Testing upload..."
railway run "ls -la public/debates/"