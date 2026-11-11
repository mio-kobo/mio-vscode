#!/usr/bin/env python3
"""Verify version-specific public package availability; reject duplicate publication even while search metadata lags."""
import argparse
import gzip
import hashlib
import io
import json
import re
import zipfile
import xml.etree.ElementTree as ET
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def inspect_package(data, version):
    if data[:2] == b'\x1f\x8b':
        data = gzip.decompress(data)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        manifest = json.loads(archive.read('extension/package.json'))
        xml = ET.fromstring(archive.read('extension.vsixmanifest'))
        identity = xml.find('.//{*}Identity')
        if identity is None or identity.get('Publisher') != 'exmikupro' or identity.get('Id') != 'mio-language-support' or identity.get('Version') != version:
            raise ValueError('Marketplace VSIX identity or version mismatch')
    if (manifest.get('publisher') != 'exmikupro' or manifest.get('name') != 'mio-language-support'
            or manifest.get('version') != version):
        raise ValueError('Marketplace package identity or version mismatch')
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', required=True)
    parser.add_argument('--unpublished', action='store_true')
    args = parser.parse_args()
    if not re.fullmatch(r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)', args.version):
        raise ValueError('Expected stable semantic version')
    url = ('https://marketplace.visualstudio.com/_apis/public/gallery/publishers/exmikupro/'
           f'vsextensions/mio-language-support/{args.version}/vspackage')
    try:
        with urlopen(Request(url, headers={'User-Agent': 'MioReleaseVerification/1.0'}), timeout=40) as response:
            digest = inspect_package(response.read(), args.version)
    except HTTPError as error:
        if error.code == 404 and args.unpublished:
            print(f'No public version-specific package for {args.version}')
            return
        raise
    if args.unpublished:
        raise ValueError(f'Already publicly available: exmikupro.mio-language-support {args.version}')
    print(f'Independently verified exmikupro.mio-language-support {args.version}; SHA256 {digest}')


if __name__ == '__main__':
    main()
