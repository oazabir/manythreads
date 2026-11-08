import { graphAdapter } from './graph.ts';

// SharePoint (PLAN Bundle D, P16-08): the document libraries of the sites the person can open, through Microsoft Graph `delta`. A root is one library; a remote id is
// `<drive id>/<item id>`. See graph.ts.
export const sharePoint = graphAdapter('sharepoint');
