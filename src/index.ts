import express from 'express';
import multer from 'multer';
import fetch from 'node-fetch';
import path from 'path';
import { promises as fs } from 'fs';
import Papa from 'papaparse';
import { read, utils, WorkBook } from 'xlsx';

interface ProcessedDocument {
  content: string;
  metadata: Record<string, any>;
  filename: string;
  mimeType: string;
  processingDate: Date;
}

interface TikaMetadata {
  [key: string]: string | number | boolean | null;
}

type SheetRow = string[] | { [key: string]: any };

class DocumentProcessor {
  private tikaUrl: string;
  private completedDir: string;
  private currentFilePath: string | null = null;
  
  constructor(
    tikaUrl: string = process.env.TIKA_SERVER_URL || 'http://localhost:9998',
    completedDir: string = './completed'
  ) {
    this.tikaUrl = tikaUrl;
    this.completedDir = completedDir;
    this.ensureDirectoryExists();
  }

  private async ensureDirectoryExists(): Promise<void> {
    try {
      await fs.access(this.completedDir);
    } catch {
      await fs.mkdir(this.completedDir, { recursive: true });
    }
  }

  private async saveProcessedDocument(result: ProcessedDocument, originalPath: string): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputFilename = `${timestamp}_${result.filename}`;
    const outputPath = path.join(this.completedDir, outputFilename);

    // Saves the processed content and metadata as JSON
    const outputData = {
      content: result.content,
      metadata: result.metadata,
      originalFilename: result.filename,
      mimeType: result.mimeType,
      processingDate: result.processingDate
    };

    await fs.writeFile(
      outputPath + '.json',
      JSON.stringify(outputData, null, 2),
      'utf8'
    );

    // saves original files
    const outputOriginalPath = path.join(this.completedDir, 'originals', outputFilename);
    await fs.mkdir(path.dirname(outputOriginalPath), { recursive: true });
    await fs.copyFile(originalPath, outputOriginalPath);
  }

  private getMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.txt': 'text/plain',
      '.csv': 'text/csv'
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  private async processXLSX(buffer: Buffer): Promise<string> {
    try {
      const workbook: WorkBook = read(buffer, { type: 'buffer' });
      let result = '';
      
      workbook.SheetNames.forEach((sheetName: string) => {
        const sheet = workbook.Sheets[sheetName];
        const jsonData = utils.sheet_to_json<SheetRow>(sheet, { header: 1 });
        
        if (workbook.SheetNames.length > 1) {
          result += `Sheet: ${sheetName}\n`;
        }
        
        jsonData.forEach((row: SheetRow) => {
          if (Array.isArray(row) && row.length > 0) {
            result += row.join('\t') + '\n';
          } else if (typeof row === 'object' && row !== null) {
            result += Object.values(row).join('\t') + '\n';
          }
        });
        result += '\n';
      });
      
      return result;
    } catch (error) {
      console.error('XLSX processing error:', error);
      throw new Error('Failed to process XLSX file');
    }
  }

  private async processCSV(buffer: Buffer): Promise<string> {
    try {
      const content = buffer.toString('utf-8');
      return new Promise<string>((resolve, reject) => {
        Papa.parse<string[]>(content, {
          complete: (results) => {
            const formattedContent = results.data
              .filter(row => row.length > 0)
              .map(row => row.join('\t'))
              .join('\n');
            resolve(formattedContent);
          },
          error: (error: any) => {
            reject(error);
          },
          skipEmptyLines: true
        });
      });
    } catch (error) {
      console.error('CSV processing error:', error);
      throw new Error('Failed to process CSV file');
    }
  }

  async processDocument(file: Buffer, filename: string, originalPath: string): Promise<ProcessedDocument> {
    const mimeType = this.getMimeType(filename);

    const contentResponse = await fetch(`${this.tikaUrl}/tika`, {
      method: 'PUT',
      body: file,
      headers: {
        'Content-Type': mimeType,
        'Accept': 'text/plain'
      }
    });

    if (!contentResponse.ok) {
      throw new Error(`Failed to extract text: ${contentResponse.statusText}`);
    }

    const content = await contentResponse.text();
    const metadata = await this.getMetadata(file, mimeType);

    const result = {
      content,
      metadata,
      filename,
      mimeType,
      processingDate: new Date()
    };

    await this.saveProcessedDocument(result, originalPath);
    return result;
  }

  async processSpreadsheet(file: Buffer, filename: string, originalPath: string): Promise<ProcessedDocument> {
    const mimeType = this.getMimeType(filename);
    const ext = path.extname(filename).toLowerCase();
    
    let content: string;
    try {
      if (ext === '.xlsx') {
        content = await this.processXLSX(file);
      } else if (ext === '.csv') {
        content = await this.processCSV(file);
      } else {
        throw new Error('Unsupported spreadsheet format');
      }

      const metadata = await this.getMetadata(file, mimeType);

      const result = {
        content,
        metadata,
        filename,
        mimeType,
        processingDate: new Date()
      };

      await this.saveProcessedDocument(result, originalPath);
      return result;
      
    } catch (error) {
      console.error('Spreadsheet processing error:', error);
      throw error;
    }
  }

  private async getMetadata(file: Buffer, mimeType: string): Promise<Record<string, any>> {
    const response = await fetch(`${this.tikaUrl}/meta`, {
      method: 'PUT',
      body: file,
      headers: {
        'Content-Type': mimeType,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to get metadata: ${response.statusText}`);
    }

    const metadata = await response.json() as TikaMetadata;
    return metadata;
  }
}

const app = express();
const upload = multer({ dest: 'uploads/' });
const processor = new DocumentProcessor();

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

app.post('/process', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileBuffer = await fs.readFile(req.file.path);
    const isSpreadsheet = ['.xlsx', '.csv'].some(ext => 
      req.file!.originalname.toLowerCase().endsWith(ext)
    );

    const result = isSpreadsheet
      ? await processor.processSpreadsheet(fileBuffer, req.file.originalname, req.file.path)
      : await processor.processDocument(fileBuffer, req.file.originalname, req.file.path);

    await fs.unlink(req.file.path);
    res.json(result);
  } catch (error) {
    console.error('Processing error:', error);
    res.status(500).json({ 
      error: 'Failed to process document',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const HOST = '0.0.0.0'; 

app.listen(PORT, HOST, () => {
  console.log(`Document processing service running on http://${HOST}:${PORT}`);
  console.log('Environment variables:', {
    TIKA_SERVER_URL: process.env.TIKA_SERVER_URL,
    PORT: process.env.PORT
  });
});