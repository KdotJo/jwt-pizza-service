#!/bin/bash
# Simulate JWT Pizza traffic so every Grafana metric has data.
# Usage: ./simulateTraffic.sh <host>      e.g. ./simulateTraffic.sh https://pizza-service.example.com
# Requires curl and jq. Expects the seed users from generateData.sh (d@jwt.com / f@jwt.com).

if [ -z "$1" ]; then
  echo "Usage: $0 <host>"
  echo "Example: $0 http://localhost:3000"
  exit 1
fi
host=$1
echo "Simulating traffic against $host (Ctrl+C to stop)"

# Kill every background loop on Ctrl+C or exit
cleanup() {
  trap - SIGINT SIGTERM EXIT
  echo "Stopping traffic simulation"
  kill $(jobs -p) 2>/dev/null
  wait 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM EXIT

login() {
  curl -s -X PUT "$host/api/auth" -d "{\"email\":\"$1\", \"password\":\"$2\"}" -H 'Content-Type: application/json' | jq -r '.token'
}

logout() {
  curl -s -o /dev/null -X DELETE "$host/api/auth" -H "Authorization: Bearer $1"
}

order() {
  # $1 token, $2 number of pizzas
  items=$(jq -nc --argjson n "$2" '[range($n)] | map({menuId: 1, description: "Veggie", price: 0.05})')
  curl -s -o /dev/null -w "%{http_code}" -X POST "$host/api/order" -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $1" -d "{\"franchiseId\": 1, \"storeId\": 1, \"items\": $items}"
}

# GET: menu every 3s
while true; do
  curl -s -o /dev/null "$host/api/order/menu"
  echo "GET menu"
  sleep 3
done &

# Failed auth: bad password every 25s
while true; do
  curl -s -o /dev/null -X PUT "$host/api/auth" -d '{"email":"unknown@jwt.com", "password":"bad"}' -H 'Content-Type: application/json'
  echo "Bad login"
  sleep 25
done &

# Successful auth + active user: franchisee logs in (PUT), browses, logs out (DELETE)
while true; do
  token=$(login f@jwt.com franchisee)
  echo "Login franchisee"
  sleep 20
  curl -s -o /dev/null "$host/api/franchise" -H "Authorization: Bearer $token"
  sleep 20
  logout "$token"
  echo "Logout franchisee"
  sleep 10
done &

# Pizza sales: diner logs in and buys a pizza every 15s for a minute, then logs out
while true; do
  token=$(login d@jwt.com diner)
  echo "Login diner"
  for i in 1 2 3 4; do
    echo "Order 1 pizza: $(order "$token" 1)"
    sleep 15
  done
  logout "$token"
  echo "Logout diner"
  sleep 5
done &

# Factory failure: a hungry diner orders 21 pizzas every ~60s (slow + 500)
while true; do
  token=$(login d@jwt.com diner)
  echo "Order 21 pizzas (expect failure): $(order "$token" 21)"
  sleep 5
  logout "$token"
  sleep 55
done &

# Extra PUT/DELETE: unauthorized menu update and logout attempts every 30s
while true; do
  curl -s -o /dev/null -X PUT "$host/api/order/menu" -H 'Content-Type: application/json' -d '{"title":"x"}'
  curl -s -o /dev/null -X DELETE "$host/api/auth"
  echo "Unauthorized PUT + DELETE"
  sleep 30
done &

wait
