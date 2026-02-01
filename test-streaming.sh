#!/bin/bash

echo "=== Testing Streaming API ==="
echo ""

echo "1. Testing API health..."
curl -s http://localhost:4001/api/v1 | jq .

echo ""
echo "2. Testing stream endpoint for movie ID 550 (Fight Club)..."
STREAM_URL=$(curl -s http://localhost:4001/api/v1/streams/550 | jq -r '.[0].url')
echo "Stream URL: $STREAM_URL"

echo ""
echo "3. Verifying stream is accessible..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -I "$STREAM_URL")
echo "HTTP Status: $HTTP_CODE"

if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ Stream URL is accessible!"
else
    echo "❌ Stream URL returned HTTP $HTTP_CODE"
fi

echo ""
echo "4. Testing stream endpoint for movie ID 10195 (Thor)..."
STREAM_URL_2=$(curl -s http://localhost:4001/api/v1/streams/10195 | jq -r '.[0].url')
echo "Stream URL: $STREAM_URL_2"

echo ""
echo "=== Frontend Configuration ==="
echo "API Base URL should be: http://localhost:4001/api/v1"
echo "Frontend should be running on: http://localhost:5173"
echo ""
echo "To test in browser:"
echo "1. Navigate to http://localhost:5173/movie/550"
echo "2. Click 'Begin Streaming'"
echo "3. Video should load and play"
