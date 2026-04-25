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

async function pushZipToRepo(extractPath, repoName, token, username) {
  await createRepo(repoName, token, username);
  const repoUrl = `https://${token}@github.com/${username}/${repoName}.git`;
  const clonePath = path.join(os.tmpdir(), `clone-${Date.now()}`);
  const git = simpleGit();

  await git.clone(repoUrl, clonePath);
  await fs.cp(extractPath, clonePath, { recursive: true, force: true });
  
  const gitClone = simpleGit(clonePath);
  await gitClone.add('.');
  await gitClone.commit('Auto upload from Telegram bot');
  await gitClone.push('origin', 'main');

  return `https://github.com/${username}/${repoName}`;
}

module.exports = { createRepo, deleteRepo, pushZipToRepo };