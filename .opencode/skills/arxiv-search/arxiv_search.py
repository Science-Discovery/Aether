#!/usr/bin/env python3
"""arXiv Search with source download.

Searches the arXiv preprint repository and optionally downloads source files.
"""

import argparse
import os
import shutil
import ssl
import tarfile
import urllib.request


def _make_ssl_ctx() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _fetch_url(url: str, dest: str) -> str:
    try:
        urllib.request.urlretrieve(url, dest)
        return dest
    except Exception:
        with urllib.request.urlopen(url, context=_make_ssl_ctx()) as resp:
            with open(dest, "wb") as f:
                f.write(resp.read())
        return dest


def _download_source(arxiv_id: str, title: str, refs_dir: str) -> str:
    safe_id = arxiv_id.replace("/", "_")
    eprint_url = f"https://arxiv.org/e-print/{arxiv_id}"
    eprint_dest = os.path.join(refs_dir, f"{safe_id}.tar.gz")
    extract_dir = os.path.join(refs_dir, safe_id)
    try:
        _fetch_url(eprint_url, eprint_dest)
        os.makedirs(extract_dir, exist_ok=True)
        with tarfile.open(eprint_dest, "r:gz") as tar:
            tar.extractall(extract_dir)
        os.remove(eprint_dest)
        return extract_dir
    except Exception:
        pdf_url = f"https://arxiv.org/pdf/{arxiv_id}"
        pdf_dest = os.path.join(refs_dir, f"{safe_id}.pdf")
        try:
            return _fetch_url(pdf_url, pdf_dest)
        except Exception as e2:
            return f"download failed: {e2}"


def query_arxiv(query: str, max_papers: int = 10, download: bool = False) -> str:
    """Query arXiv for papers based on the provided search query.

    Parameters
    ----------
    query : str
        The search query string.
    max_papers : int
        The maximum number of papers to retrieve (default: 10).
    download : bool
        If True, download source tarballs to refs/ (default: False).

    Returns:
        The formatted search results or an error message.
    """
    try:
        import arxiv  # type: ignore[import-not-found]
    except ImportError:
        return "Error: arxiv package not installed. Install with: pip install arxiv"

    try:
        client = arxiv.Client()
        search = arxiv.Search(
            query=query, max_results=max_papers, sort_by=arxiv.SortCriterion.Relevance
        )

        refs_dir = ""
        if download:
            refs_dir = os.path.join(os.getcwd(), "refs")
            os.makedirs(refs_dir, exist_ok=True)

        parts = []
        for paper in client.results(search):
            paper_id = paper.entry_id.replace("http://arxiv.org/abs/", "").replace(
                "https://arxiv.org/abs/", ""
            )
            entry = f"Title: {paper.title}\nSummary: {paper.summary}"
            if download:
                path = _download_source(paper_id, paper.title, refs_dir)
                entry += f"\nSource: {path}"
            parts.append(entry)

        results = "\n\n".join(parts)
        return results or "No papers found on arXiv."
    except Exception as e:
        return f"Error querying arXiv: {e}"


def main() -> None:
    """Main entry point for the arXiv search CLI tool."""
    parser = argparse.ArgumentParser(description="Search arXiv for research papers")
    parser.add_argument("query", type=str, help="Search query string")
    parser.add_argument(
        "--max-papers",
        type=int,
        default=10,
        help="Maximum number of papers to retrieve (default: 10)",
    )
    parser.add_argument(
        "--download",
        action="store_true",
        help="Download source tarballs for each paper to refs/",
    )

    args = parser.parse_args()

    print(query_arxiv(args.query, max_papers=args.max_papers, download=args.download))


if __name__ == "__main__":
    main()
