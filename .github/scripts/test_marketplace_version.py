import gzip
import hashlib
import importlib.util
import io
import json
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('marketplace_guard', Path(__file__).with_name('check-marketplace-version.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def package(**overrides):
    manifest = dict(publisher='exmikupro', name='mio-language-support', version='0.3.1')
    manifest.update(overrides)
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w') as archive:
        archive.writestr('extension/package.json', json.dumps(manifest))
        archive.writestr('extension.vsixmanifest', f'<PackageManifest><Metadata><Identity Id="{manifest["name"]}" Publisher="{manifest["publisher"]}" Version="{manifest["version"]}" /></Metadata></PackageManifest>')
    return data.getvalue()


class MarketplaceTests(unittest.TestCase):
    def test_verifies_plain_and_transport_gzipped_packages(self):
        data = package()
        expected = hashlib.sha256(data).hexdigest()
        self.assertEqual(guard.inspect_package(data, '0.3.1'), expected)
        self.assertEqual(guard.inspect_package(gzip.compress(data), '0.3.1'), expected)

    def test_rejects_wrong_identity_or_version(self):
        for overrides in [dict(publisher='other'), dict(name='other'), dict(version='0.3.0')]:
            with self.assertRaises(ValueError):
                guard.inspect_package(package(**overrides), '0.3.1')

    def test_rejects_json_xml_manifest_disagreement(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, 'w') as archive:
            archive.writestr('extension/package.json', json.dumps(dict(publisher='exmikupro', name='mio-language-support', version='0.3.1')))
            archive.writestr('extension.vsixmanifest', '<PackageManifest><Metadata><Identity Id="mio-language-support" Publisher="other" Version="0.3.1" /></Metadata></PackageManifest>')
        with self.assertRaises(ValueError):
            guard.inspect_package(data.getvalue(), '0.3.1')

    def test_does_not_treat_html_success_response_as_publication(self):
        with self.assertRaises(zipfile.BadZipFile):
            guard.inspect_package(b'<html>not found</html>', '0.3.1')


if __name__ == '__main__':
    unittest.main()
