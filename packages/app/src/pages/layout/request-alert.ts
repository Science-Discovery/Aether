export function shouldNotify(input: {
  current_dir?: string
  current_session?: string
  dir: string
  session_id: string
}) {
  return input.dir !== input.current_dir || input.session_id !== input.current_session
}

export function dismissKeys(input: {
  current_dir?: string
  current_session?: string
}) {
  if (!input.current_dir || !input.current_session) return []
  return [`${input.current_dir}:${input.current_session}`]
}
