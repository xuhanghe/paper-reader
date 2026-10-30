import { chooseFolder, NoNativeDialog } from "@/lib/native-dialogs";

export const runtime = "nodejs";

// The system's folder dialog — macOS or Windows — for a workspace's directory
export async function POST() {
  try {
    const root = await chooseFolder("Choose or create the folder for this research workspace");
    if (root === null) return Response.json({ cancelled: true }, { status: 499 });
    return Response.json({ root });
  } catch (error) {
    if (error instanceof NoNativeDialog) return Response.json({ error: error.message }, { status: 501 });
    return Response.json({ error: error instanceof Error ? error.message : "Could not open the folder dialog." }, { status: 500 });
  }
}
