#!/usr/bin/env bash
# Starts the dev MongoDB replica set used by .env (127.0.0.1:27117, replSet "testset").
# Runs in the foreground (start it with run_in_background). Initiates the replica set once it is reachable.
set -u

MONGOD="${MONGOD:-$(ls ~/.cache/mongodb-binaries/mongod-x64-win32-*.exe 2>/dev/null | sort | tail -1)}"
DBPATH="${LOCALAPPDATA:-$HOME/AppData/Local}/bijliwala/mongo-data"
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

if [ -z "$MONGOD" ] || [ ! -f "$MONGOD" ]; then
  echo "No mongod binary in ~/.cache/mongodb-binaries. Run the API integration tests once (they download it) or set MONGOD=<path>." >&2
  exit 1
fi
mkdir -p "$DBPATH"

# Initiate the replica set in the background once mongod accepts connections (no-op if already initiated).
(
  cd "$REPO_ROOT/apps/api" && node -e "
const {MongoClient}=require('mongoose').mongo;
(async()=>{for(let i=0;i<60;i++){try{
  const c=new MongoClient('mongodb://127.0.0.1:27117/?directConnection=true',{serverSelectionTimeoutMS:1000});await c.connect();
  let h=await c.db('admin').command({hello:1});
  if(!h.setName){await c.db('admin').command({replSetInitiate:{_id:'testset',members:[{_id:0,host:'127.0.0.1:27117'}]}});}
  for(let j=0;j<40&&!h.isWritablePrimary;j++){await new Promise(r=>setTimeout(r,500));h=await c.db('admin').command({hello:1});}
  console.log('[start-mongo] replica set', h.setName, 'primary:', h.isWritablePrimary);await c.close();return;
}catch(e){await new Promise(r=>setTimeout(r,1000));}}console.log('[start-mongo] could not reach mongod on 27117');})()"
) &

exec "$MONGOD" --replSet testset --port 27117 --bind_ip 127.0.0.1 --dbpath "$DBPATH" --wiredTigerCacheSizeGB 0.25
