#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

out_dir="${1:-dist/pages}"
api_base_url="${SONOX_API_BASE_URL:-}"

if [[ "${GITHUB_ACTIONS:-}" == "true" && -z "${api_base_url}" ]]; then
    echo "SONOX_API_BASE_URL is required for GitHub Pages deployment." >&2
    exit 1
fi

if [[ -n "${api_base_url}" && ! "${api_base_url}" =~ ^https?:// ]]; then
    api_base_url="https://${api_base_url}"
    echo "Normalized SONOX_API_BASE_URL to ${api_base_url}" >&2
fi

if [[ "${GITHUB_ACTIONS:-}" == "true" && -n "${api_base_url}" && ! "${api_base_url}" =~ ^https:// ]]; then
    echo "GitHub Pages is served over HTTPS, so SONOX_API_BASE_URL must use https://." >&2
    exit 1
fi

rm -rf "${out_dir}"
mkdir -p "${out_dir}"

cp frontend/index.html "${out_dir}/index.html"
cp frontend/app.js "${out_dir}/app.js"
cp frontend/styles.css "${out_dir}/styles.css"
cp frontend/favicon.ico "${out_dir}/favicon.ico"
cp -R assets "${out_dir}/assets"
cp -R translations "${out_dir}/translations"

escaped_api_base_url=$(printf "%s" "${api_base_url}" | sed "s/'/'\\\\''/g")
cat > "${out_dir}/config.js" <<EOF
window.SONOX_CONFIG = {
    apiBaseUrl: '${escaped_api_base_url}',
};
EOF

touch "${out_dir}/.nojekyll"

echo "GitHub Pages site built at ${out_dir}"
