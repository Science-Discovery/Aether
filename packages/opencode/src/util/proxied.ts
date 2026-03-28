export function proxied() {
  return !!(
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.ALL_PROXY ||
    process.env.http_proxy ||
    process.env.https_proxy ||
    process.env.all_proxy
  )
}
