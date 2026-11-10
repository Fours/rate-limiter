import { useState } from 'react';
import { EdgeView } from './components/EdgeView.tsx';
import { Dashboard } from './Dashboard.tsx';
import type { AlgorithmName } from './redis/scripts.ts';
import { useEdgeLab } from './useEdgeLab.ts';
import { useEdgeView } from './useEdgeView.ts';
import { useSimulation } from './useSimulation.ts';

export function App() {
  const sim = useSimulation();
  const [algorithm, setAlgorithm] = useState<AlgorithmName>('token-bucket');
  const edge = useEdgeView();
  const lab = useEdgeLab(edge.open);
  return (
    <>
      <Dashboard sim={sim} algorithm={algorithm} setAlgorithm={setAlgorithm} showEdge={edge.show} />
      {edge.open && <EdgeView lab={lab} onClose={edge.hide} />}
    </>
  );
}
