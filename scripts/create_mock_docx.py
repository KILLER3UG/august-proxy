import zipfile
import os

docx_path = '/app/host_files/mock.docx'
# Ensure directory exists
os.makedirs(os.path.dirname(docx_path), exist_ok=True)

xml_content = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r>
        <w:t>Hello world, this is a mock docx file for testing!</w:t>
      </w:r>
    </w:p>
  </w:body>
</w:document>
"""

with zipfile.ZipFile(docx_path, 'w') as z:
    z.writestr('word/document.xml', xml_content)

print("mock.docx created successfully at:", docx_path)
