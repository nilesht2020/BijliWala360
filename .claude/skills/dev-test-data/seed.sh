#!/usr/bin/env bash
# Seed sample users into the LOCAL Bijli Wala dev stack through the public API (fixed dev OTP 123456).
# Usage: seed.sh                      -> default sample set
#        seed.sh <professional|vendor|company> <+91mobile> "<name>"
set -u
BASE="${BASE:-http://localhost:5173/api/v1}"
case "$BASE" in http://localhost*|http://127.0.0.1*) ;; *) echo "Refusing to seed non-local BASE=$BASE" >&2; exit 1 ;; esac
H='Content-Type: application/json'

field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }

signin() { # type mobile name -> prints access token
  local type=$1 mobile=$2 name=$3 r cid v st
  r=$(curl -s -m 10 -X POST "$BASE/auth/otp/request" -H "$H" -d "{\"mobile\":\"$mobile\"}")
  cid=$(echo "$r" | field challengeId)
  [ -z "$cid" ] && { echo "otp/request failed for $mobile: $r" >&2; return 1; }
  v=$(curl -s -m 10 -X POST "$BASE/auth/otp/verify" -H "$H" -d "{\"challengeId\":\"$cid\",\"code\":\"123456\"}")
  st=$(echo "$v" | field signupToken)
  if [ -n "$st" ]; then
    v=$(curl -s -m 10 -X POST "$BASE/auth/signup" -H "$H" \
      -d "{\"signupToken\":\"$st\",\"name\":\"$name\",\"userType\":\"$type\",\"acceptTerms\":true}")
  fi
  echo "$v" | field accessToken
}

create_company() { # token mobile name
  local tok=$1 mobile=$2 name=$3 n pan r
  n=$(( (${mobile: -4} % 9000) + 1000 ))
  pan="ABCDE${n}F"
  r=$(curl -s -m 10 -X POST "$BASE/companies" -H "$H" -H "Authorization: Bearer $tok" -d "{
    \"legalName\":\"$name Pvt Ltd\",\"pan\":\"$pan\",\"gstin\":\"27${pan}1Z5\",\"industry\":\"Facility management\",\"size\":\"51-200\",
    \"billingAddress\":{\"line1\":\"1 Industrial Estate\",\"city\":\"Pune\",\"state\":\"Maharashtra\",\"stateCode\":\"27\",\"pincode\":\"411001\"}}")
  if echo "$r" | grep -q '"success":true'; then echo "  company created: $name Pvt Ltd (PAN $pan, pending verification)";
  elif echo "$r" | grep -qi 'already'; then echo "  company already exists";
  else echo "  company create response: $(echo "$r" | cut -c1-200)"; fi
}

seed_one() { # kind mobile name
  local kind=$1 mobile=$2 name=$3 type tok me
  case "$kind" in professional) type=PROFESSIONAL ;; vendor) type=VENDOR ;; company) type=COMPANY ;;
    *) echo "unknown kind $kind" >&2; return 1 ;; esac
  tok=$(signin "$type" "$mobile" "$name") || return 1
  [ -z "$tok" ] && { echo "$kind $mobile: sign-in failed" >&2; return 1; }
  me=$(curl -s -m 10 "$BASE/auth/me" -H "Authorization: Bearer $tok")
  echo "$kind $mobile -> $(echo "$me" | field name) roles=$(echo "$me" | sed -n 's/.*"roleCodes":\[\([^]]*\)\].*/\1/p')"
  [ "$kind" = company ] && create_company "$tok" "$mobile" "$name"
  return 0
}

if [ $# -ge 3 ]; then
  seed_one "$1" "$2" "$3"
else
  seed_one professional +919800000101 "Ravi Electrician"
  seed_one professional +919800000102 "Imran Plumber"
  seed_one vendor       +919800000301 "Kumar Contractors"
  seed_one company      +919800000201 "Asha Facilities"
fi
echo "Sign in at http://localhost:5173/login with any number above; OTP 123456."
