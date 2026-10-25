export interface QuarkFileReference {
  shareUrl: string;
  fileId: string;
  name: string;
  size: number;
  /** Private account binding; never included in public task responses. */
  accountKey: string;
}

export interface QuarkShareFile {
  id: string;
  name: string;
  size: number;
  isDirectory: boolean;
  downloadable: boolean;
}
