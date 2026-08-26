#!/bin/bash
cd /root/BOT
pkill -f "src/index.js" 2>/dev/null
pkill -f "npm start" 2>/dev/null
sleep 2
setsid nohup node src/index.js >> /tmp/bot-boot.log 2>&1 < /dev/null &
echo "launcher done, pid $!"
