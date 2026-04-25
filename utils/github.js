const { simpleGit } = require('simple-git');
const { promises: fs } = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');

async function createRepo(name, token, username) {
  const url = `https://api.github.com/user/repos`;
  const res = await axios.post(url, { name, private: false }, {
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' }
  });
  return res.data;
}

async function deleteRepo(name, token, username) {
  const url = `https://api.github.com/repos/${username}/${name}`;
  await axios.delete(url, { headers: { Authorization: `token ${token}` } });
}

async function listRepos(token, username) {
  const url = `https://api.github.com/users/${username}/repos?per_page=100`;
  const res = await axios.get(url, {
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' }
  });
  return res.data;
}

async function pushZipToNewRepo(extractPath, repoName, token, username) {
  await createRepo(repoName, token, username);
  return await pushToRepo(extractPath, repoName, token, username);
}

async function updateExistingRepo(extractPath, repoName, token, username) {
  // Check if repo exists
  try {
    const url = `https://api.github.com/repos/${username}/${repoName}`;
    await axios.get(url, { headers: { Authorization: `token ${token}` } });
  } catch (err) {
    throw new Error(`Repo ${repoName} tidak ditemukan!`);
  }
  return await pushToRepo(extractPath, repoName, token, username, true);
}

async function pushToRepo(extractPath, repoName, token, username, isUpdate = false) {
  const repoUrl = `https://${token}@github.com/${username}/${repoName}.git`;
  const clonePath = path.join(os.tmpdir(), `clone-${Date.now()}`);
  const git = simpleGit();

  await git.clone(repoUrl, clonePath);
  
  // Copy files (overwrite if exists)
  await fs.cp(extractPath, clonePath, { recursive: true, force: true });
  
  const gitClone = simpleGit(clonePath);
  
  // Check if we need to pull first (for update)
  if (isUpdate) {
    try {
      await gitClone.pull('origin', 'main');
    } catch (e) {
      try {
        await gitClone.pull('origin', 'master');
      } catch (pullErr) {
        // Ignore pull errors
      }
    }
  }
  
  await gitClone.add('.');
  
  // Check if there are changes
  const status = await gitClone.status();
  if (status.files.length === 0) {
    return `https://github.com/${username}/${repoName} (tidak ada perubahan)`;
  }
  
  await gitClone.commit(`Auto ${isUpdate ? 'update' : 'upload'} from Telegram bot - ${new Date().toISOString()}`);
  
  // Push
  try {
    await gitClone.push('origin', 'main');
  } catch (e) {
    await gitClone.push('origin', 'master');
  }

  return `https://github.com/${username}/${repoName}`;
}

module.exports = { 
  createRepo, 
  deleteRepo, 
  listRepos,
  pushZipToNewRepo, 
  updateExistingRepo 
};
