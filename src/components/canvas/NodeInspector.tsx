import { useStore } from '@xyflow/react';
import { SlidersHorizontal, X } from 'lucide-react';
import GenerateDock from './GenerateDock';
import NodeParamBar from './NodeParamBar';
import { NodeGlyph } from './nodeIcons';
import { NODE_META, displayLabelOf, usesGenerateDock, upscaleFollowsConnection, upscaleFollowedLabel, upscaleFollowedSide } from './nodeMeta';
import type { NodeKind } from './nodeMeta';
import type { NodeData } from './types';

export default function NodeInspector({ node, onClose }: {
  node: { id: string; data: NodeData } | null;
  onClose: () => void;
}) {
  const kind = (node?.data.kind || 'text') as NodeKind;
  const follows = upscaleFollowsConnection(kind);
  const side = useStore(state => node && follows ? upscaleFollowedSide(node.id, state.nodes, state.edges) : '');
  const from = useStore(state => node && follows ? upscaleFollowedLabel(node.id, state.nodes, state.edges) : '');
  return <aside className="cv-inspector" aria-label="节点参数">
    <header className="cv-inspector-head">
      <SlidersHorizontal size={16} aria-hidden />
      <h2>节点参数</h2>
      <button className="cv-btn icon ghost" type="button" title="收起参数栏" aria-label="收起参数栏" onClick={onClose}><X size={16} /></button>
    </header>
    {node ? <>
      <div className="cv-inspector-selection">
        <NodeGlyph kind={kind} size={18} />
        <div><strong>{displayLabelOf(node.data) || NODE_META[kind].label}</strong><span>{NODE_META[kind].label}</span></div>
      </div>
      {usesGenerateDock(kind)
        ? <GenerateDock key={node.id} data={node.data} nodeId={node.id} inspector />
        : kind !== 'text'
          ? <div className="cv-inspector-content"><NodeParamBar key={node.id} data={node.data} followedSide={side} followedFrom={from} /></div>
          : <div className="cv-inspector-content"><dl className="cv-inspector-facts"><dt>类型</dt><dd>文本</dd><dt>字符</dt><dd>{String(node.data.text || '').length}</dd></dl></div>}
    </> : <div className="cv-inspector-empty"><SlidersHorizontal size={28} strokeWidth={1.3} /><span>未选中节点</span></div>}
  </aside>;
}
