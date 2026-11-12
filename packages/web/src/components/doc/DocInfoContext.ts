import { createContext, useContext } from 'react';

/** The document being shown (for titles in fullscreen views etc.). */
export const DocInfoContext = createContext<{ kind: string; id: string; title: string } | null>(null);
export const useDocInfo = () => useContext(DocInfoContext);
