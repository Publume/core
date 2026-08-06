const GITHUB_API_VERSION = '2026-03-10'

async function dispatch(env) {
  if (!env.GITHUB_REPOSITORY) throw new Error('GITHUB_REPOSITORY is required')
  const eventType = env.GITHUB_EVENT_TYPE || 'publume-schedule'
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/dispatches`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'User-Agent': 'publume-scheduler',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    },
    body: JSON.stringify({
      event_type: eventType,
    }),
  })

  if (!response.ok) throw new Error(`GitHub dispatch failed: ${response.status} ${await response.text()}`)
}

export default {
  async scheduled(_controller, env) {
    await dispatch(env)
  },
}
