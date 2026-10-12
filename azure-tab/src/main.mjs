import {connect,loadPullRequest} from './azure.mjs';
import {start} from './app.mjs';
try {await start(await connect(),loadPullRequest);}catch(error){document.getElementById('notice').textContent=String(error.message||error);}
