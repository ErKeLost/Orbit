import { createFileRoute } from '@tanstack/react-router'

import { Stage } from '../components/Stage'

export const Route = createFileRoute('/')({ component: Landing })

/**
 * The page is the stage: `main` already holds it from the shell, so the route
 * exists only to own the URL (and to leave room for a changelog later).
 */
function Landing() {
  return <Stage />
}
