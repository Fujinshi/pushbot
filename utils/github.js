const { promises: fs } = require('fs');
const path = require('path');
const axios = require('axios');
const mime = require('mime-types');

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

async function getDefaultBranch(token, username, repoName) {
  try {
    const url = `https://api.github.com/repos/${username}/${repoName}`;
    const res = await axios.get(url, {
      headers: { Authorization: `token ${token}` }
    });
    return res.data.default_branch;
  } catch (err) {
    return 'main';
  }
}

async function uploadFilesToRepo(extractPath, repoName, token, username, isUpdate = false) {
  // Check if repo exists, if not create it
  let repoExists = true;
  try {
    await axios.get(`https://api.github.com/repos/${username}/${repoName}`, {
      headers: { Authorization: `token ${token}` }
    });
  } catch (err) {
    repoExists = false;
    if (!isUpdate) {
      await createRepo(repoName, token, username);
    } else {
      throw new Error(`Repo ${repoName} tidak ditemukan!`);
    }
  }

  const defaultBranch = await getDefaultBranch(token, username, repoName);
  
  // Get current commit SHA (for updating)
  let currentCommitSha = null;
  let currentTreeSha = null;
  
  if (repoExists && isUpdate) {
    try {
      const refUrl = `https://api.github.com/repos/${username}/${repoName}/git/refs/heads/${defaultBranch}`;
      const refRes = await axios.get(refUrl, {
        headers: { Authorization: `token ${token}` }
      });
      currentCommitSha = refRes.data.object.sha;
      
      const commitUrl = `https://api.github.com/repos/${username}/${repoName}/git/commits/${currentCommitSha}`;
      const commitRes = await axios.get(commitUrl, {
        headers: { Authorization: `token ${token}` }
      });
      currentTreeSha = commitRes.data.tree.sha;
    } catch (err) {
      // Branch mungkin belum ada
    }
  }

  // Walk through directory and collect files
  const files = [];
  async function walkDir(dir, basePath = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.join(basePath, entry.name);
      if (entry.isDirectory()) {
        await walkDir(fullPath, relativePath);
      } else {
        const content = await fs.readFile(fullPath);
        const contentBase64 = content.toString('base64');
        files.push({
          path: relativePath.replace(/\\/g, '/'),
          content: contentBase64,
          encoding: 'base64'
        });
      }
    }
  }
  
  await walkDir(extractPath);
  
  if (files.length === 0) {
    return `https://github.com/${username}/${repoName} (tidak ada file)`;
  }

  // Create blobs and build tree
  const blobs = [];
  for (const file of files) {
    const blobRes = await axios.post(
      `https://api.github.com/repos/${username}/${repoName}/git/blobs`,
      { content: file.content, encoding: file.encoding },
      { headers: { Authorization: `token ${token}` } }
    );
    blobs.push({
      path: file.path,
      mode: '100644',
      type: 'blob',
      sha: blobRes.data.sha
    });
  }

  // Create tree
  const treeRes = await axios.post(
    `https://api.github.com/repos/${username}/${repoName}/git/trees`,
    { base_tree: currentTreeSha, tree: blobs },
    { headers: { Authorization: `token ${token}` } }
  );
  const newTreeSha = treeRes.data.sha;

  // Create commit
  const commitRes = await axios.post(
    `https://api.github.com/repos/${username}/${repoName}/git/commits`,
    {
      message: `Auto ${isUpdate ? 'update' : 'upload'} from Telegram bot - ${new Date().toISOString()}`,
      tree: newTreeSha,
      parents: currentCommitSha ? [currentCommitSha] : []
    },
    { headers: { Authorization: `token ${token}` } }
  );
  const newCommitSha = commitRes.data.sha;

  // Update branch reference
  await axios.patch(
    `https://api.github.com/repos/${username}/${repoName}/git/refs/heads/${defaultBranch}`,
    { sha: newCommitSha, force: true },
    { headers: { Authorization: `token ${token}` } }
  );

  return `https://github.com/${username}/${repoName}`;
}

async function pushZipToNewRepo(extractPath, repoName, token, username) {
  return await uploadFilesToRepo(extractPath, repoName, token, username, false);
}

async function updateExistingRepo(extractPath, repoName, token, username) {
  return await uploadFilesToRepo(extractPath, repoName, token, username, true);
}

module.exports = { 
  createRepo, 
  deleteRepo, 
  listRepos,
  pushZipToNewRepo, 
  updateExistingRepo 
};
