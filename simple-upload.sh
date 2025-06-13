#!/bin/bash

echo "🚂 Simple Railway Upload"
echo "========================"

# Set token
export RAILWAY_TOKEN=775a3b1e-37dd-46cf-aa93-46b8c2eb8ab6

# Link project
railway link 388935f6-4305-4087-be51-95ab9f14b59c

# Interactive shell method
echo "Starting Railway shell..."
echo "Once inside, run these commands:"
echo "  mkdir -p public/debates"
echo "  exit"
echo ""

railway shell