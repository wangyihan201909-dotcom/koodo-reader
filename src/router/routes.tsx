import BookList from "../containers/lists/bookList";
import DeletedBookList from "../containers/lists/deletedBookList";
import EmptyPage from "../containers/emptyPage";
import ResearchWorkspacePage from "../components/research/workspace";

export const routes = [
  { path: "empty", component: EmptyPage },
  { path: "note", component: ResearchWorkspacePage },
  { path: "highlight", component: ResearchWorkspacePage },
  { path: "research", component: ResearchWorkspacePage },
  { path: "home", component: BookList },
  { path: "shelf", component: BookList },
  { path: "favorite", component: BookList },
  { path: "trash", component: DeletedBookList },
];

